/**
 * 파일 보기 HTML 미리보기의 「요소 지정」. 미리보기 iframe(`sandbox="allow-scripts"`, 출처 없음) 안에
 * 고르기 스크립트를 덧붙이고, 그 스크립트가 보낸 메시지를 부모가 검사해 받는다.
 *
 * 신뢰 경계: 메시지는 그 iframe의 창(`event.source`)에서 왔고, 이번에 틀 때 만든 nonce를 지녔고, 모양과
 * 길이가 맞을 때만 받는다. 같은 iframe 안의 페이지 스크립트도 같은 창이라 이론상 흉내 낼 수 있으므로,
 * 받은 값은 글자로만 보이고(HTML로 그리지 않음) 사용자가 누를 때만 입력창에 들어간다.
 */

export const HTML_PICK_MESSAGE = "cuelo-html-pick";
export const HTML_PICK_EXIT_MESSAGE = "cuelo-html-pick-exit";

export const PICK_TEXT_MAX = 160;
export const PICK_START_TAG_MAX = 300;
const PICK_SELECTOR_MAX = 1000;
const PICK_TAG_MAX = 64;
const PICK_ID_MAX = 256;
const PICK_CLASS_MAX = 128;
const PICK_CLASSES_MAX = 32;

export interface PickedRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PickedElement {
  selector: string;
  tag: string;
  id: string;
  classes: string[];
  text: string;
  startTag: string;
  rect: PickedRect;
  viewport: { w: number; h: number };
}

export type PickMessage = { kind: "pick"; element: PickedElement } | { kind: "exit" };

function isString(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length <= max;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function readRect(value: unknown): PickedRect | null {
  if (!value || typeof value !== "object") return null;
  const r = value as Record<string, unknown>;
  if (!isFiniteNumber(r.x) || !isFiniteNumber(r.y) || !isFiniteNumber(r.w) || !isFiniteNumber(r.h)) return null;
  if (r.w < 0 || r.h < 0) return null;
  return { x: r.x, y: r.y, w: r.w, h: r.h };
}

/**
 * 받을 메시지인지 가린다. `source`는 `MessageEvent.source`, `frameWindow`는 그 미리보기 iframe의
 * `contentWindow`다. 다른 창·다른 nonce·모양이 틀리거나 너무 긴 값은 모두 null이다.
 */
export function readPickMessage(source: unknown, data: unknown, frameWindow: unknown, nonce: string): PickMessage | null {
  if (!frameWindow || source !== frameWindow || !nonce) return null;
  if (!data || typeof data !== "object") return null;
  const message = data as Record<string, unknown>;
  if (message.nonce !== nonce) return null;
  if (message.type === HTML_PICK_EXIT_MESSAGE) return { kind: "exit" };
  if (message.type !== HTML_PICK_MESSAGE) return null;
  const { selector, tag, id, classes, text, startTag } = message;
  if (!isString(selector, PICK_SELECTOR_MAX) || selector.length === 0) return null;
  if (!isString(tag, PICK_TAG_MAX) || !/^[a-z][a-z0-9-]*$/.test(tag)) return null;
  if (!isString(id, PICK_ID_MAX) || !isString(text, PICK_TEXT_MAX) || !isString(startTag, PICK_START_TAG_MAX)) return null;
  if (!Array.isArray(classes) || classes.length > PICK_CLASSES_MAX || !classes.every((c) => isString(c, PICK_CLASS_MAX))) return null;
  const rect = readRect(message.rect);
  const viewport = message.viewport as Record<string, unknown> | null | undefined;
  if (!rect || !viewport || typeof viewport !== "object" || !isFiniteNumber(viewport.w) || !isFiniteNumber(viewport.h) || viewport.w <= 0 || viewport.h <= 0) return null;
  return {
    kind: "pick",
    element: { selector, tag, id, classes: [...classes], text, startTag, rect, viewport: { w: viewport.w, h: viewport.h } },
  };
}

/**
 * 고른 요소의 여는 태그가 파일 원문에 꼭 한 번 나오면 그 줄(1부터). 없거나 두 번 이상이면 null.
 * 브라우저가 다시 쓴 태그(속성 따옴표·순서)가 원문과 다르면 찾지 못하고, 그때는 파일 경로로 가리킨다.
 */
export function findStartTagLine(content: string, startTag: string): number | null {
  if (!startTag) return null;
  const first = content.indexOf(startTag);
  if (first < 0 || content.indexOf(startTag, first + 1) >= 0) return null;
  let line = 1;
  for (let index = content.indexOf("\n"); index >= 0 && index < first; index = content.indexOf("\n", index + 1)) line += 1;
  return line;
}

export interface ElementLocatorLabels {
  element: (selector: string) => string;
  text: (text: string) => string;
  position: (values: { x: number; y: number; w: number; h: number; vw: number; vh: number }) => string;
}

/** 입력창에 넣을 위치 설명. 첫 줄은 파일(또는 그 줄) 멘션, 이어서 요소·글자·화면 위치. 글자가 없으면 그 줄을 뺀다. */
export function buildElementLocatorText(mention: string, element: PickedElement, labels: ElementLocatorLabels): string {
  const lines = [mention.trimEnd(), labels.element(element.selector)];
  if (element.text) lines.push(labels.text(element.text));
  lines.push(labels.position({
    x: Math.round(element.rect.x),
    y: Math.round(element.rect.y),
    w: Math.round(element.rect.w),
    h: Math.round(element.rect.h),
    vw: Math.round(element.viewport.w),
    vh: Math.round(element.viewport.h),
  }));
  return `${lines.join("\n")}\n`;
}

/**
 * 미리보기 원문 끝(마지막 `</body>` 앞, 없으면 맨 끝)에 고르기 스크립트를 붙인다. 원문은 그대로 두고
 * 덧붙이기만 한다.
 */
export function injectPickerScript(content: string, nonce: string): string {
  const script = `<script>${pickerScriptSource(nonce)}</script>`;
  // 대소문자 구분 없이 원문에서 바로 찾는다. 소문자로 바꾼 사본은 유니코드에 따라 길이가 달라져 위치가 어긋난다.
  let at = -1;
  for (const match of content.matchAll(/<\/body>/gi)) at = match.index;
  return at < 0 ? content + script : content.slice(0, at) + script + content.slice(at);
}

/**
 * iframe 안에서 도는 스크립트. 덮개 없이 capture 단계에서 포인터를 받아, 올린 요소에 테두리를 띄우고
 * 누른 요소를 골라 부모에 보낸다. 누른 것이 링크·단추여도 페이지 동작은 막는다. 자기 `<script>`는
 * 지워 페이지의 요소 순서(nth-of-type)를 바꾸지 않고, nonce는 함수 안에만 둔다.
 */
export function pickerScriptSource(nonce: string): string {
  return `(function(){
var NONCE=${JSON.stringify(nonce)},TYPE=${JSON.stringify(HTML_PICK_MESSAGE)},EXIT=${JSON.stringify(HTML_PICK_EXIT_MESSAGE)};
var host=window.parent;
if(document.currentScript)document.currentScript.remove();
var box=document.createElement("div");
box.setAttribute("aria-hidden","true");
box.style.cssText="position:fixed;pointer-events:none;z-index:2147483647;border:2px solid #e5484d;outline:1px solid #fff;border-radius:2px;display:none;box-sizing:border-box";
document.documentElement.appendChild(box);
function pickable(t){return t&&t.nodeType===1&&t!==box&&t!==document.documentElement&&t!==document.body;}
function esc(v){return window.CSS&&CSS.escape?CSS.escape(v):String(v).replace(/[^a-zA-Z0-9_-]/g,"\\\\$&");}
function uniqueId(el){return el.id&&esc(el.id).length<=200&&document.querySelectorAll("#"+esc(el.id)).length===1;}
function cssPath(el){
  if(uniqueId(el))return "#"+esc(el.id);
  var parts=[],node=el;
  while(node&&node.nodeType===1&&node!==document.body&&node!==document.documentElement){
    if(node!==el&&uniqueId(node)){parts.unshift("#"+esc(node.id));break;}
    var tag=node.tagName.toLowerCase(),part=tag,parent=node.parentElement;
    if(parent){var same=0,index=0;for(var c=parent.firstElementChild;c;c=c.nextElementSibling){if(c.tagName===node.tagName){same++;if(c===node)index=same;}}if(same>1)part+=":nth-of-type("+index+")";}
    parts.unshift(part);node=parent;
    if(node===document.body){parts.unshift("body");break;}
  }
  // 부모 검사가 받는 길이 안에 들도록, 너무 길면 앞쪽 조상부터 떼어 낸다(끝 요소에 가까운 경로는 남는다).
  while(parts.length>1&&parts.join(" > ").length>${PICK_SELECTOR_MAX})parts.shift();
  var sel=parts.join(" > ");
  return sel.length>${PICK_SELECTOR_MAX}?sel.slice(-${PICK_SELECTOR_MAX}):sel;
}
function startTag(el){var s=el.cloneNode(false).outerHTML,end="</"+el.tagName.toLowerCase()+">";if(s.slice(-end.length).toLowerCase()===end)s=s.slice(0,-end.length);return s.slice(0,${PICK_START_TAG_MAX});}
function show(el){var r=el.getBoundingClientRect();box.style.display="block";box.style.left=r.left+"px";box.style.top=r.top+"px";box.style.width=r.width+"px";box.style.height=r.height+"px";}
function block(e){e.preventDefault();e.stopPropagation();e.stopImmediatePropagation();}
window.addEventListener("pointermove",function(e){if(pickable(e.target))show(e.target);else box.style.display="none";},true);
window.addEventListener("pointerleave",function(){box.style.display="none";},true);
["pointerdown","mousedown","mouseup","pointerup","auxclick","dblclick"].forEach(function(n){window.addEventListener(n,function(e){if(pickable(e.target))block(e);},true);});
window.addEventListener("submit",block,true);
window.addEventListener("click",function(e){
  block(e);
  // 누르기 기본 동작을 막아 이 문서가 초점을 받지 못하므로, Escape가 이 문서로 오도록 직접 초점을 가져온다.
  try{window.focus();}catch(err){}
  var el=e.target;if(!pickable(el))return;
  show(el);
  var r=el.getBoundingClientRect();
  var text=(el.textContent||"").replace(/\\s+/g," ").trim().slice(0,${PICK_TEXT_MAX});
  host.postMessage({type:TYPE,nonce:NONCE,selector:cssPath(el),tag:el.tagName.toLowerCase(),id:String(el.id||"").slice(0,256),
    classes:Array.prototype.slice.call(el.classList,0,32).map(function(c){return c.slice(0,128);}),text:text,startTag:startTag(el),
    rect:{x:r.left,y:r.top,w:r.width,h:r.height},viewport:{w:window.innerWidth,h:window.innerHeight}},"*");
},true);
window.addEventListener("keydown",function(e){if(e.key==="Escape"){block(e);host.postMessage({type:EXIT,nonce:NONCE},"*");}},true);
})();`;
}
