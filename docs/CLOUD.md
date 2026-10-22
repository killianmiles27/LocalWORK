# Local and cloud models

LocalWORK starts in **Local only**. Cloud routing is an optional core feature because the host must control where conversation data goes. Plugins do not receive provider keys or choose destinations.

In **Settings → Cloud**, add an OpenAI-compatible provider with its API base URL and optional key. Fetch its models or enter model IDs yourself. Keys and ChatGPT tokens are stored in Windows Credential Manager; provider addresses and model IDs are stored in settings. Network discovery and sign-in require internet access. Model availability and provider charges depend on the account.

ChatGPT subscription sign-in uses an unofficial Codex OAuth integration, similar to pi and OpenCode. A browser opens for sign-in; LocalWORK listens for the callback on loopback port 1455. This is not an official LocalWORK partnership or a guarantee that a subscription supports this client. Refresh models to query the backend; cached results may be stale and no guessed model IDs are supplied. Live account sign-in and inference still require verification. OpenAI also documents a registered [Sign in with ChatGPT integration](https://developers.openai.com/siwc/quickstart); the current integration has not migrated to it.

## Choose where a chat runs

- **Local only:** all model requests stay on this PC, including chats with an earlier cloud selection.
- **Manual:** choose Local or a clearly labelled Cloud model in the composer model menu. Without a choice, the chat stays local.
- **Automatic:** requires the installed and enabled privacy filter. Start local; use the default cloud model if the local server is unavailable, the estimated request exceeds 90% of the local context, or a tool error repeats. Pin Local to prevent escalation for a chat.

Offline mode, chats kept offline, and privacy locks take precedence over cloud choices. A cloud connection failure can fall back to a ready local model in Automatic mode. A failed privacy check falls back locally in either routing mode. A fallback cannot undo a request already sent.

Automatic routing currently uses these rules; it does not judge general task difficulty. It does not integrate NVIDIA Switchyard, promise mathematical escalation, or implement a local-model `ask_cloud` helper. [Switchyard](https://github.com/NVIDIA-NeMo/Switchyard) provides an embeddable Rust library, but Windows integration and calibration against a real local/cloud model pair remain future work. Its standalone server is described as a demo/evaluation tool.

The composer shows the selected location and receives routing updates. Open the model menu for the reason, privacy lock and **View last cloud request**. This shows the most recent attempted cloud payload and its local placeholder map; it is in memory and is lost when the app exits. Review it before sharing. Route metadata is logged locally in `logs/routing.jsonl` without full prompt content. Choices take effect for subsequent model requests, not requests already in progress.

## Privacy filter

Click **Install privacy filter** to download [PII-Tracer](https://huggingface.co/perplexity-ai/PII-Tracer-GGUF), its heads/configuration and a Windows CPU build of llama.cpp. The download is about 1.25 GB. This starts a separate CPU helper when scanning is needed; it does not load a second copy of the main GPU model. The helper stops with LocalWORK. Nothing downloads merely from opening Settings.

Enable **Check cloud requests for personal data**. Supported text is scanned locally; detected spans become stable placeholders and replies are restored locally. High sensitivity locks the chat local. Unsupported attachments, unavailable detection or scan errors stay local rather than bypassing the filter. Extracted attachment text is checked when it enters conversation/tool history; this is not a whole-disk or pre-read document scanner. The test box runs locally.

Detection is probabilistic: absence of a finding is not proof that text is safe. Use Local only or Offline for medical, financial or other records that must never leave this PC. In Manual mode with the privacy filter disabled, the selected cloud provider receives conversation text and tool output without redaction. Web tools and approved external commands have their own network behavior; model routing is not an operating-system firewall.

## Validation limits

Regression tests exercise policy, payload handling, stream completion and local UI controls with mocks. They do not verify a live provider account, actual model quality, successful privacy-model installation, detector latency, or subscription entitlement. Do not infer those from a clean build.
