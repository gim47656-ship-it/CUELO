//! Session JSONL reader for `lib/upkeep/sessions.ts`.
//!
//! The reader splits a file into lines exactly as Bun's `createReadStream` + `readline` (`crlfDelay: Infinity`)
//! does and decodes each line as UTF-8 with U+FFFD for invalid bytes. serde_json reads each line into the fields
//! the scan uses and writes a smaller JSON object holding them. Every kept value is the original source text
//! (`RawValue`), so `JSON.parse` of the projection gives the same values as `JSON.parse` of the full line: escapes,
//! lone surrogates in values, huge numbers and `null` all carry over. A line serde cannot read into that shape
//! (invalid JSON, a duplicate field, a non-object message or block, a lone-surrogate key, a non-object line) is
//! passed on whole as a JSON string, and TypeScript parses it as before.
//! Counting, time windows, dedup and secret masking stay in TypeScript; this is not redaction.

use memchr::memmem;
use memchr::{memchr2, memrchr2};
use napi::bindgen_prelude::AsyncTask;
use napi::{Env, Error, Result, Status, Task};
use napi_derive::napi;
use serde::de::value::MapAccessDeserializer;
use serde::de::{IgnoredAny, MapAccess, SeqAccess, Visitor};
use serde::{Deserialize, Deserializer};
use serde_json::value::RawValue;
use std::borrow::Cow;
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::fmt;
use std::fs::File;
use std::io::{ErrorKind, Read};
use std::marker::PhantomData;
use std::sync::{Arc, Mutex};

/// Raw bytes read per batch before it is handed to JS. A line still unfinished then waits in `carry` for the next
/// batch, so a batch can be empty while a line longer than this is being read.
const BATCH_BYTES: usize = 1 << 20;

struct State {
    path: String,
    file: Option<File>,
    /// Bytes read but not yet split into lines (the unfinished last line).
    carry: Vec<u8>,
    eof: bool,
    done: bool,
    /// Read error met after some lines of a batch were already projected; reported by the next call.
    pending_error: Option<String>,
}

/// One file read in batches. `next()` resolves to a JSON array text of projected entries, or `null` at the end.
#[napi]
pub struct UpkeepReader {
    state: Arc<Mutex<State>>,
}

#[napi]
impl UpkeepReader {
    #[napi(constructor)]
    pub fn new(path: String) -> Self {
        UpkeepReader {
            state: Arc::new(Mutex::new(State { path, file: None, carry: Vec::new(), eof: false, done: false, pending_error: None })),
        }
    }

    /// Reads and projects the next batch on the libuv thread pool. Calls must not overlap.
    #[napi(ts_return_type = "Promise<string | null>")]
    pub fn next(&self) -> AsyncTask<NextBatch> {
        AsyncTask::new(NextBatch { state: self.state.clone() })
    }

    /// Closes the file early (the scan stopped reading this file).
    #[napi]
    pub fn close(&self) {
        if let Ok(mut state) = self.state.lock() {
            state.file = None;
            state.carry = Vec::new();
            state.done = true;
        }
    }
}

pub struct NextBatch {
    state: Arc<Mutex<State>>,
}

impl Task for NextBatch {
    type Output = Option<String>;
    type JsValue = Option<String>;

    fn compute(&mut self) -> Result<Self::Output> {
        let mut state = self.state.lock().map_err(|_| Error::new(Status::GenericFailure, "upkeep reader lock poisoned"))?;
        state.next_batch().map_err(|message| Error::new(Status::GenericFailure, message))
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}

impl State {
    fn next_batch(&mut self) -> std::result::Result<Option<String>, String> {
        if let Some(message) = self.pending_error.take() {
            self.done = true;
            return Err(message);
        }
        if self.done {
            return Ok(None);
        }
        if self.file.is_none() && !self.eof {
            self.file = Some(File::open(&self.path).map_err(|e| format!("{e}: open '{}'", self.path))?);
        }
        let mut out = String::from("[");
        let mut read = 0;
        while read < BATCH_BYTES && !self.eof {
            let start = self.carry.len();
            self.carry.resize(start + BATCH_BYTES, 0);
            let file = self.file.as_mut().expect("file is open until eof");
            let got = loop {
                match file.read(&mut self.carry[start..]) {
                    Ok(n) => break Ok(n),
                    Err(e) if e.kind() == ErrorKind::Interrupted => continue,
                    Err(e) => break Err(format!("{e}: read '{}'", self.path)),
                }
            };
            let got = match got {
                Ok(n) => n,
                Err(message) => {
                    self.carry.clear();
                    self.file = None;
                    if out.len() > 1 {
                        self.pending_error = Some(message);
                        break;
                    }
                    self.done = true;
                    return Err(message);
                }
            };
            self.carry.truncate(start + got);
            read += got;
            if got == 0 {
                self.eof = true;
                self.file = None;
                break;
            }
            // Split up to the last line end; the rest waits for more bytes. Without CR or LF, the last U+2028/U+2029
            // (E2 80 A8/A9, which may straddle the previous read) also ends a line, so such files stay in batches.
            let from = start.saturating_sub(2);
            let cut = memrchr2(b'\n', b'\r', &self.carry[start..]).map(|i| start + i + 1).or_else(|| {
                memmem::rfind_iter(&self.carry[from..], b"\xe2\x80")
                    .map(|i| from + i)
                    .find(|&i| matches!(self.carry.get(i + 2), Some(0xa8 | 0xa9)))
                    .map(|i| i + 3)
            });
            if let Some(cut) = cut {
                project_lines(&self.carry[..cut], &mut out);
                self.carry.drain(..cut);
            }
        }
        if self.eof {
            let tail = std::mem::take(&mut self.carry);
            project_lines(&tail, &mut out);
            self.done = true;
            if out.len() == 1 {
                return Ok(None);
            }
        }
        out.push(']');
        Ok(Some(out))
    }
}

/// Splits on CR and LF bytes (CRLF only adds an empty line, which `JSON.parse` would reject anyway) and on
/// U+2028/U+2029 after decoding, as readline does. Invalid UTF-8 never swallows a CR or LF, so decoding each
/// line on its own gives the same text as decoding the stream.
fn project_lines(bytes: &[u8], out: &mut String) {
    let mut start = 0;
    while start <= bytes.len() {
        let end = memchr2(b'\n', b'\r', &bytes[start..]).map_or(bytes.len(), |i| start + i);
        if end > start {
            let text: Cow<str> = String::from_utf8_lossy(&bytes[start..end]);
            // U+2028 and U+2029 are E2 80 A8 and E2 80 A9 in UTF-8.
            let line = text.as_bytes();
            let mut from = 0;
            for at in memmem::find_iter(line, b"\xe2\x80") {
                if at >= from && matches!(line.get(at + 2), Some(0xa8 | 0xa9)) {
                    if at > from {
                        project_entry(&line[from..at], out);
                    }
                    from = at + 3;
                }
            }
            if line.len() > from {
                project_entry(&line[from..], out);
            }
        }
        start = end + 1;
    }
}

// ---- Projection ----

/// A present value kept as raw text, `null` included (null and absent differ for `!==` and `=== undefined`).
#[derive(Default, Clone, Copy)]
struct Raw<'a>(Option<&'a RawValue>);

impl<'de: 'a, 'a> Deserialize<'de> for Raw<'a> {
    fn deserialize<D: Deserializer<'de>>(d: D) -> std::result::Result<Self, D::Error> {
        Ok(Raw(Some(<&'a RawValue>::deserialize(d)?)))
    }
}

#[derive(Deserialize)]
#[serde(transparent)]
struct BorrowedText<'a>(#[serde(borrow)] Cow<'a, str>);

impl Raw<'_> {
    fn is(&self, name: &str) -> bool {
        self.0.is_some_and(|v| serde_json::from_str::<BorrowedText>(v.get()).is_ok_and(|s| s.0 == name))
    }
}

#[derive(Deserialize)]
struct Entry<'a> {
    #[serde(default, borrow, rename = "type")]
    kind: Raw<'a>,
    #[serde(default, borrow)]
    id: Raw<'a>,
    #[serde(default, borrow)]
    timestamp: Raw<'a>,
    #[serde(default, borrow, rename = "customType")]
    custom_type: Raw<'a>,
    #[serde(default, borrow)]
    purpose: Raw<'a>,
    #[serde(default, borrow)]
    provider: Raw<'a>,
    #[serde(default, borrow)]
    content: Raw<'a>,
    #[serde(default, borrow)]
    usage: Raw<'a>,
    #[serde(default, borrow)]
    data: Raw<'a>,
    #[serde(default, borrow)]
    details: Raw<'a>,
    #[serde(default, borrow)]
    cwd: Raw<'a>,
    /// null and absent read the same in sessions.ts (`!entry.message`, `?.`), so both are dropped below.
    #[serde(default, borrow)]
    message: Option<Obj<Message<'a>>>,
}

#[derive(Deserialize)]
struct Message<'a> {
    #[serde(default, borrow)]
    role: Raw<'a>,
    #[serde(default, borrow)]
    attribution: Raw<'a>,
    #[serde(default, borrow)]
    timestamp: Raw<'a>,
    #[serde(default, borrow)]
    content: Raw<'a>,
    #[serde(default, borrow)]
    usage: Raw<'a>,
    #[serde(default, borrow)]
    model: Raw<'a>,
    #[serde(default, borrow)]
    provider: Raw<'a>,
    #[serde(default, borrow, rename = "toolCallId")]
    tool_call_id: Raw<'a>,
    #[serde(default, borrow, rename = "credentialId")]
    credential_id: Raw<'a>,
    #[serde(default, borrow, rename = "toolName")]
    tool_name: Raw<'a>,
    #[serde(default, borrow, rename = "isError")]
    is_error: Raw<'a>,
    #[serde(default, borrow)]
    details: Raw<'a>,
}

#[derive(Deserialize)]
struct ResultDetails<'a> {
    #[serde(default, borrow, rename = "toolCommands")]
    tool_commands: Raw<'a>,
    #[serde(default, borrow, rename = "exitCode")]
    exit_code: Raw<'a>,
    #[serde(default, borrow)]
    refused: Option<Obj<Refused<'a>>>,
    #[serde(default, borrow, rename = "scriptError")]
    script_error: Raw<'a>,
    #[serde(default, borrow)]
    stage: Raw<'a>,
    #[serde(default, borrow, rename = "jobId")]
    job_id: Raw<'a>,
    #[serde(default, borrow)]
    jobs: Raw<'a>,
}

#[derive(Deserialize)]
struct Refused<'a> {
    #[serde(default, borrow)]
    by: Raw<'a>,
}

#[derive(Deserialize)]
struct ToolCommand<'a> {
    #[serde(default, borrow)]
    tool: Raw<'a>,
    #[serde(default, borrow)]
    mode: Raw<'a>,
    #[serde(default, borrow, rename = "exitCode")]
    exit_code: Raw<'a>,
    #[serde(default, borrow)]
    inner: Option<Obj<PendingFinalize<'a>>>,
}

#[derive(Deserialize)]
struct PendingFinalize<'a> {
    #[serde(default, borrow)]
    stage: Raw<'a>,
    #[serde(default, borrow, rename = "jobId")]
    job_id: Raw<'a>,
    #[serde(default, borrow)]
    refused: Option<Obj<Refused<'a>>>,
    #[serde(default, borrow, rename = "scriptError")]
    script_error: Raw<'a>,
}

#[derive(Deserialize)]
struct RecoveredJob<'a> {
    #[serde(default, borrow)]
    id: Raw<'a>,
    #[serde(default, borrow)]
    status: Raw<'a>,
    #[serde(default, borrow, rename = "toolResultDetails")]
    result: Raw<'a>,
}

#[derive(Deserialize)]
struct Block<'a> {
    #[serde(default, borrow, rename = "type")]
    kind: Raw<'a>,
    #[serde(default, borrow)]
    id: Raw<'a>,
    #[serde(default, borrow)]
    name: Raw<'a>,
    #[serde(default, borrow)]
    arguments: Raw<'a>,
}

#[derive(Deserialize)]
struct TextBlock<'a> {
    #[serde(default, borrow)]
    text: Raw<'a>,
}

/// One pass over a value that should be an object. A JSON object is read into `T`; `null` and any other value are
/// skipped, as `JSON.parse` keeps them and their fields read `undefined` (a derived struct alone would also read an
/// array by position). An object serde cannot read (duplicate field, ...) is an error, which sends the whole line.
enum Obj<T> {
    Object(T),
    Null,
    Other,
}

impl<'de, T: Deserialize<'de>> Deserialize<'de> for Obj<T> {
    fn deserialize<D: Deserializer<'de>>(d: D) -> std::result::Result<Self, D::Error> {
        d.deserialize_any(ObjVisitor(PhantomData))
    }
}

struct ObjVisitor<T>(PhantomData<T>);

impl<'de, T: Deserialize<'de>> Visitor<'de> for ObjVisitor<T> {
    type Value = Obj<T>;

    fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
        f.write_str("a JSON value")
    }
    fn visit_map<A: MapAccess<'de>>(self, map: A) -> std::result::Result<Self::Value, A::Error> {
        T::deserialize(MapAccessDeserializer::new(map)).map(Obj::Object)
    }
    fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> std::result::Result<Self::Value, A::Error> {
        while seq.next_element::<IgnoredAny>()?.is_some() {}
        Ok(Obj::Other)
    }
    fn visit_unit<E>(self) -> std::result::Result<Self::Value, E> {
        Ok(Obj::Null)
    }
    fn visit_bool<E>(self, _: bool) -> std::result::Result<Self::Value, E> {
        Ok(Obj::Other)
    }
    fn visit_i64<E>(self, _: i64) -> std::result::Result<Self::Value, E> {
        Ok(Obj::Other)
    }
    fn visit_u64<E>(self, _: u64) -> std::result::Result<Self::Value, E> {
        Ok(Obj::Other)
    }
    fn visit_f64<E>(self, _: f64) -> std::result::Result<Self::Value, E> {
        Ok(Obj::Other)
    }
    fn visit_str<E>(self, _: &str) -> std::result::Result<Self::Value, E> {
        Ok(Obj::Other)
    }
}

struct W<'a> {
    out: &'a mut String,
    first: bool,
}

impl W<'_> {
    fn key(&mut self, name: &str) {
        if !self.first {
            self.out.push(',');
        }
        self.first = false;
        self.out.push('"');
        self.out.push_str(name);
        self.out.push_str("\":");
    }
    fn field(&mut self, name: &str, v: Raw) {
        if let Some(v) = v.0 {
            self.key(name);
            self.out.push_str(v.get());
        }
    }
}

struct WriteToolCommands<'a, 'b>(&'a mut W<'b>);

impl<'de> Visitor<'de> for WriteToolCommands<'_, '_> {
    type Value = ();

    fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
        f.write_str("a tool command array")
    }

    fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> std::result::Result<(), A::Error> {
        let w = self.0;
        let mut wrote_command = false;
        while let Some(command) = seq.next_element::<Obj<ToolCommand>>()? {
            let Obj::Object(command) = command else { continue };
            // RawValue has already validated the JSON. A numeric token starts with a digit or minus.
            if !command.exit_code.0.is_some_and(|v| matches!(v.get().as_bytes()[0], b'-' | b'0'..=b'9'))
                || !command.mode.is("execute")
                || !(command.tool.is("recall") || command.tool.is("git_finalize"))
            {
                continue;
            }
            let pending = if command.tool.is("git_finalize") {
                match command.inner {
                    Some(Obj::Object(inner)) => {
                        let refused = matches!(&inner.refused, Some(Obj::Object(refusal)) if refusal.by.0.is_some_and(|by| by.get().starts_with('"')));
                        if refused || inner.script_error.0.is_some_and(|value| value.get() == "true") {
                            continue;
                        }
                        inner.stage.is("pending").then_some(inner)
                    }
                    _ => None,
                }
            } else {
                None
            };
            if wrote_command {
                w.out.push(',');
            } else {
                w.key("toolCommands");
                w.out.push('[');
                wrote_command = true;
            }

            w.out.push('{');
            let mut cw = W { out: w.out, first: true };
            cw.field("tool", command.tool);
            cw.field("mode", command.mode);
            cw.field("exitCode", command.exit_code);
            if let Some(pending) = pending {
                cw.key("inner");
                cw.out.push('{');
                let mut iw = W { out: cw.out, first: true };
                iw.field("stage", pending.stage);
                iw.field("jobId", pending.job_id);
                cw.out.push('}');
            }
            w.out.push('}');
        }
        if wrote_command {
            w.out.push(']');
        }
        Ok(())
    }
}

struct WriteRecoveredJobs<'a, 'b>(&'a mut W<'b>);

impl<'de> Visitor<'de> for WriteRecoveredJobs<'_, '_> {
    type Value = ();

    fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
        f.write_str("a recovered job array")
    }

    fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> std::result::Result<(), A::Error> {
        let w = self.0;
        let mut wrote_job = false;
        while let Some(job) = seq.next_element::<Obj<RecoveredJob>>()? {
            let Obj::Object(job) = job else { continue };
            if !job.status.is("completed") || job.result.0.is_none() {
                continue;
            }
            if wrote_job {
                w.out.push(',');
            } else {
                w.key("jobs");
                w.out.push('[');
                wrote_job = true;
            }
            w.out.push('{');
            let mut jw = W { out: w.out, first: true };
            jw.field("id", job.id);
            jw.field("status", job.status);
            jw.field("toolResultDetails", job.result);
            w.out.push('}');
        }
        if wrote_job {
            w.out.push(']');
        }
        Ok(())
    }
}

fn project_entry(line: &[u8], out: &mut String) {
    let text = std::str::from_utf8(line).expect("decoded line");
    let start = out.len();
    if out.len() > 1 {
        out.push(',');
    }
    if write_projection(text, out).is_none() {
        out.truncate(start);
        if out.len() > 1 {
            out.push(',');
        }
        out.push_str(&serde_json::to_string(text).expect("string"));
    }
}

fn write_projection(text: &str, out: &mut String) -> Option<()> {
    // A derived struct would also read an array line by position; JSON.parse keeps the array (fields undefined).
    if !text.trim_start_matches([' ', '\t', '\n', '\r']).starts_with('{') {
        return None;
    }
    let e: Entry = serde_json::from_str(text).ok()?;
    out.push('{');
    let mut w = W { out, first: true };
    w.field("type", e.kind);
    w.field("id", e.id);
    w.field("timestamp", e.timestamp);
    w.field("customType", e.custom_type);
    w.field("purpose", e.purpose);
    w.field("provider", e.provider);
    w.field("usage", e.usage);
    w.field("cwd", e.cwd);
    let custom = e.kind.is("custom") || e.kind.is("custom_message");
    // Every `custom_message` reaches the model, so its text is kept for the context load count (sessions.ts).
    if e.kind.is("custom_message") || (custom && e.custom_type.is("async-result")) {
        w.field("content", e.content);
    }
    if custom && e.custom_type.is("async-result") {
        w.field("details", e.details);
    }
    if custom && ["mnemopi-recall", "mnemopi-recall-gated", "system-prompt-digest"].iter().any(|k| e.custom_type.is(k)) {
        w.field("data", e.data);
    }
    let m = match e.message {
        None | Some(Obj::Null) => None,
        // A message that is not an object (string, array, number) is left to JSON.parse with the whole line.
        Some(Obj::Other) => return None,
        Some(Obj::Object(m)) => Some(m),
    };
    if let Some(m) = m {
        w.key("message");
        w.out.push('{');
        let mut mw = W { out: w.out, first: true };
        mw.field("role", m.role);
        mw.field("attribution", m.attribution);
        mw.field("timestamp", m.timestamp);
        mw.field("usage", m.usage);
        mw.field("model", m.model);
        mw.field("provider", m.provider);
        mw.field("toolCallId", m.tool_call_id);
        mw.field("credentialId", m.credential_id);
        mw.field("toolName", m.tool_name);
        mw.field("isError", m.is_error);
        if let Some(raw) = m.details.0.filter(|v| m.role.is("toolResult") && v.get().starts_with('{')) {
            let details: ResultDetails = serde_json::from_str(raw.get()).ok()?;
            let start = mw.out.len();
            let first = mw.first;
            mw.key("details");
            mw.out.push('{');
            let mut dw = W { out: mw.out, first: true };
            dw.field("exitCode", details.exit_code);
            dw.field("scriptError", details.script_error);
            if details.stage.is("pending") {
                dw.field("stage", details.stage);
                dw.field("jobId", details.job_id);
            }
            if let Some(Obj::Object(refusal)) = details.refused {
                if refusal.by.0.is_some_and(|by| by.get().starts_with('"')) {
                    dw.key("refused");
                    dw.out.push('{');
                    W { out: dw.out, first: true }.field("by", refusal.by);
                    dw.out.push('}');
                }
            }
            if let Some(commands) = details.tool_commands.0.filter(|v| m.tool_name.is("bash") && v.get().starts_with('[')) {
                serde_json::Deserializer::from_str(commands.get())
                    .deserialize_seq(WriteToolCommands(&mut dw))
                    .ok()?;
            }
            if let Some(jobs) = details.jobs.0.filter(|v| (m.tool_name.is("wait") || m.tool_name.is("hub")) && v.get().starts_with('[')) {
                serde_json::Deserializer::from_str(jobs.get())
                    .deserialize_seq(WriteRecoveredJobs(&mut dw))
                    .ok()?;
            }
            if dw.first {
                mw.out.truncate(start);
                mw.first = first;
            } else {
                mw.out.push('}');
            }
        }
        if let Some(content) = m.content.0 {
            let failed = m.is_error.0.is_some_and(|v| !matches!(v.get(), "false" | "null"));
            let result_text = m.role.is("toolResult") && (failed || ["wait", "hub", "git_finalize"].iter().any(|k| m.tool_name.is(k)));
            // A successful read result is usually a whole file. The context load count only needs its size and whether the
            // same session got exactly the same result before, so it gets the UTF-8 byte length of the stored JSON value and
            // a fingerprint of those bytes (DefaultHasher::new is the same for every call in one process), not the text.
            if m.role.is("toolResult") && !failed && m.tool_name.is("read") {
                let mut hasher = DefaultHasher::new();
                content.get().hash(&mut hasher);
                mw.key("contentBytes");
                mw.out.push_str(&content.get().len().to_string());
                mw.key("contentHash");
                mw.out.push_str(&format!("\"{:016x}\"", hasher.finish()));
            }
            if m.role.is("assistant") {
                mw.key("content");
                if content.get().starts_with('[') {
                    let blocks: Vec<Obj<Block>> = serde_json::from_str(content.get()).ok()?;
                    mw.out.push('[');
                    let mut first = true;
                    for b in blocks {
                        // Only object blocks can be tool calls (`block?.type`).
                        let Obj::Object(b) = b else { continue };
                        if !b.kind.is("toolCall") {
                            continue;
                        }
                        if !first {
                            mw.out.push(',');
                        }
                        first = false;
                        mw.out.push('{');
                        let mut bw = W { out: mw.out, first: true };
                        bw.field("type", b.kind);
                        bw.field("id", b.id);
                        bw.field("name", b.name);
                        bw.field("arguments", b.arguments);
                        bw.out.push('}');
                    }
                    mw.out.push(']');
                } else {
                    mw.out.push_str("null");
                }
            } else if m.role.is("user") || result_text {
                mw.key("content");
                let raw = content.get();
                if raw.starts_with('"') {
                    mw.out.push_str(raw);
                } else if raw.starts_with('[') {
                    let blocks: Vec<Obj<TextBlock>> = serde_json::from_str(raw).ok()?;
                    mw.out.push('[');
                    for (i, b) in blocks.into_iter().enumerate() {
                        if i > 0 {
                            mw.out.push(',');
                        }
                        // `x?.text ?? ""` in textOf: anything without text (null, string, number, array) is null here.
                        let text = if let Obj::Object(b) = b { b.text.0 } else { None };
                        match text {
                            Some(v) => {
                                mw.out.push_str("{\"text\":");
                                mw.out.push_str(v.get());
                                mw.out.push('}');
                            }
                            None => mw.out.push_str("null"),
                        }
                    }
                    mw.out.push(']');
                } else {
                    mw.out.push_str("null");
                }
            }
        }
        mw.out.push('}');
    }
    w.out.push('}');
    Some(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};

    #[test]
    fn projects_only_the_counted_bash_dispatch_fields() {
        let mut output = String::new();
        let input = r#"{"type":"message","message":{"role":"toolResult","toolName":"bash",
            "content":[{"type":"text","text":"stdout"}],
            "details":{"exitCode":1,"toolCommands":[
                {"tool":"recall","mode":"execute","exitCode":1,"args":{"query":"fixture"}},
                {"tool":"recall","mode":"help","exitCode":0},
                {"tool":"git_finalize","mode":"execute","exitCode":"0"},
                ["git_finalize","execute",0],
                {"tool":"read","mode":"execute","exitCode":0},
                {"tool":"git\u005ffinalize","mode":"execute","exitCode":0,"inner":{"stage":"complete"}},
                {"tool":"git_finalize","mode":"execute","exitCode":0,"inner":{"stage":"pending","jobId":"bg_nested","extra":true}}
            ]}}}"#;

        assert_eq!(write_projection(input, &mut output), Some(()));
        assert_eq!(
            serde_json::from_str::<Value>(&output).unwrap(),
            json!({"type":"message","message":{"role":"toolResult","toolName":"bash",
                "details":{"exitCode":1,"toolCommands":[
                    {"tool":"recall","mode":"execute","exitCode":1},
                    {"tool":"git_finalize","mode":"execute","exitCode":0},
                    {"tool":"git_finalize","mode":"execute","exitCode":0,"inner":{"stage":"pending","jobId":"bg_nested"}}
                ]}
            }})
        );
    }

    #[test]
    fn projects_refusal_and_script_error_without_other_details() {
        for (source, expected) in [
            (json!({"refused":{"by":"command-guard","unused":true},"unused":true}), json!({"refused":{"by":"command-guard"}})),
            (json!({"refused":{"by":7,"unused":true}}), Value::Null),
            (json!({"refused":{}}), Value::Null),
            (json!({"stage":"pending","jobId":"bg_fixture","unused":true}), json!({"stage":"pending","jobId":"bg_fixture"})),
            (json!({"scriptError":true,"cells":[{"code":"fixture"}]}), json!({"scriptError":true})),
        ] {
            let input = json!({"type":"message","message":{"role":"toolResult","toolName":"eval","isError":false,"details":source}});
            let mut output = String::new();
            assert_eq!(write_projection(&input.to_string(), &mut output), Some(()));
            assert_eq!(serde_json::from_str::<Value>(&output).unwrap()["message"]["details"], expected);
        }
    }
}
