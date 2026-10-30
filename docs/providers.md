# Model providers

Xiryn talks to models through the [AI SDK](https://ai-sdk.dev). Configure as many providers as you like — in `.env` or **Settings → Providers** — and pick a model per agent or a workspace default.

Models are always written `provider/model-id`. Only the first slash separates the two, so ids that contain slashes (OpenRouter) work as-is.

## Choosing a model

Agents use tools constantly. Pick a model that supports **tool calling**. For desktop work (`screen_capture`, clicking, typing) it must also accept **image input**. Strong reasoning helps with long, multi-step tasks; fast, cheap models are fine for chatty agents without a workstation.

The model picker lists what your key can actually use, fetched live from the provider, and accepts any id you type.

## Hosted providers

| Provider | Variable | Example model | Get a key |
| --- | --- | --- | --- |
| OpenAI | `OPENAI_API_KEY` | `openai/gpt-6-luna` | [platform.openai.com](https://platform.openai.com/api-keys) |
| Anthropic | `ANTHROPIC_API_KEY` | `anthropic/claude-sonnet-5-5` | [console.anthropic.com](https://console.anthropic.com/settings/keys) |
| Google Gemini | `GOOGLE_GENERATIVE_AI_API_KEY` | pick from the live list | [aistudio.google.com](https://aistudio.google.com/apikey) |
| xAI | `XAI_API_KEY` | pick from the live list | [console.x.ai](https://console.x.ai) |
| Groq | `GROQ_API_KEY` | pick from the live list | [console.groq.com](https://console.groq.com/keys) |
| Mistral | `MISTRAL_API_KEY` | pick from the live list | [console.mistral.ai](https://console.mistral.ai/api-keys) |
| DeepSeek | `DEEPSEEK_API_KEY` | pick from the live list | [platform.deepseek.com](https://platform.deepseek.com/api_keys) |
| OpenRouter | `OPENROUTER_API_KEY` | `openrouter/<vendor>/<model>` | [openrouter.ai](https://openrouter.ai/keys) |

Each hosted provider also accepts a `<PROVIDER>_BASE_URL` (e.g. `OPENAI_BASE_URL`) for proxies or regional endpoints.

## Local models

Run models on your own hardware and nothing — not even the prompt — leaves your machine except workstation and web calls.

### Ollama

The quickest way: in the Xiryn folder, run

```bash
npm run setup:local
```

It installs Ollama if it's missing (asking first), starts it, downloads a model that fits your computer's memory and makes it the default for every agent. To choose the model yourself: `npm run setup -- --local --model=gemma4:e4b`.

From the app, **Settings → Local models** shows whether Ollama is running, lists your downloaded models, downloads new ones with a progress bar (any name from [ollama.com/library](https://ollama.com/library)) and makes one the default in a click.

By hand:

```bash
ollama pull qwen3.5:9b
```

```bash
# .env
OLLAMA_BASE_URL=http://127.0.0.1:11434/v1
XIRYN_DEFAULT_MODEL=ollama/qwen3.5:9b
```

Agents need a model with tool calling; one with vision also lets them see their desktop. These work well:

| Model | Download | Fits |
| --- | --- | --- |
| `qwen3.5:2b` | 2.7 GB | any computer — chat and simple tasks |
| `qwen3.5:4b` | 3.3 GB | 12 GB of memory and up |
| `gemma4:e4b` | 6.6 GB | 16 GB and up |
| `qwen3.5:9b` | 6.6 GB | 20 GB and up — better reasoning and desktop use |
| `qwen3.6:27b` | about 17 GB | 40 GB and up — the strongest |

Replies on local models are marked *free* and never count toward the monthly budget.

**Context size.** Unless asked otherwise, Ollama runs a model with a small context (4K on many machines) and silently cuts longer prompts — and an agent's instructions alone are several thousand tokens. Xiryn uses Ollama's own chat API, which takes the context per request, and asks for 32K with every turn (16K on computers with under 12 GB of memory). It also asks Ollama to keep the model loaded for 30 minutes between turns. Your models aren't changed, so they behave as before in other apps. `OLLAMA_BASE_URL` works with or without the `/v1` that OpenAI-style tools use.

### LM Studio

Start the local server in LM Studio (Developer → Start server), then:

```bash
LMSTUDIO_BASE_URL=http://127.0.0.1:1234/v1
```

Use `lmstudio/<model-id>` as shown in the picker.

## Any OpenAI-compatible API

vLLM, LiteLLM, Together, Fireworks, a corporate gateway — anything that speaks the OpenAI chat completions API:

```bash
CUSTOM_BASE_URL=https://your-endpoint/v1
CUSTOM_API_KEY=...        # if required
```

Use `custom/<model-id>`.

## Defaults

```bash
XIRYN_DEFAULT_MODEL=openai/gpt-6-luna   # used by agents without their own model
XIRYN_MAX_STEPS=40                      # max tool calls per turn
XIRYN_TURN_TIMEOUT_MINUTES=30           # stop a turn after this long (0: no limit)
```

Without `XIRYN_DEFAULT_MODEL`, Xiryn uses the first recommended model of the first configured provider.

## Costs

Xiryn is free; providers bill you directly. The **Usage** page shows input, output, cached and reasoning tokens per turn, model and agent. Set spending limits in your provider's dashboard.
