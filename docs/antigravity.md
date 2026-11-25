# Antigravity in CUELO

Choose a project, then select **Antigravity** in the sidebar rail. Start a **New Antigravity chat** or reopen one under **Past conversations**. Antigravity keeps this history separately from your OMP sessions.

Use the same composer to type a message or attach context. Replies stream into the transcript, with tool activity and file changes shown alongside them. When Antigravity asks for permission, review the action and choose **Allow once** or **Deny**. To steer a running turn, send another message. Select **Stop** to cancel it. The composer shows the Gemini models and thinking levels that Antigravity makes available.

Files sent as Antigravity attachments can remain protected from automatic cleanup indefinitely because CUELO does not scan Antigravity conversation history for attachment references.

## Connect the official CLI

Open CUELO over HTTPS, or use `localhost` on the computer running it. Antigravity is not available over plain HTTP at a LAN address.

CUELO launches the installed official `agy` with the single argument `acp`. It looks for the absolute executable path in `CUELO_AGY_BIN`, then for `agy` in the absolute directories on `PATH`, then for the newest official binary in the local OMP download cache.

To sign in, run `agy acp --login` in a terminal on the computer running CUELO. Use the full path shown in CUELO if `agy` is not on `PATH`. Finish signing in and select **Retry**. CUELO does not ask for credentials or handle the sign-in callback.

Use this separate chat for single-user, interactive work. It does not register an OMP model or send prompts from another agent. If the CUELO server restarts before a reply finishes, reopen the conversation, restore the last message to the composer, and review it before sending again. CUELO never sends it for you.

See the [official Antigravity ACP guide](https://antigravity.google/docs/ide/extensions/acp) for CLI requirements and supported client features.

## Choose the display character

In default mode, HIKARI(히카리) appears next to Antigravity replies. In office mode, put a `seats.antigravity` entry in `characters-office/roster.json` under the agent directory. Set `id`, `alias`, and `names`; `face` is an optional path to an image under `characters-office/`. With no seat, CUELO shows the neutral Antigravity avatar and name.

This seat changes the display only. It does not set Antigravity's voice, prompt, model, or tools.
