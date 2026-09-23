# Jev with OpenRouter and LangChain

Local reference for calling TypeSafe's Jev model through OpenRouter, and for
using Jev inside LangChain. Sources are listed at the bottom.

> Naming: there is no model called "jeb". The model is **Jev** (TypeSafe's
> flagship System One model).

## What Jev is

Jev evaluates a `state` (string, JSON object, or array) against typed questions
and returns structured answers in one request. It does not generate text, so it
is not a chat model and has no grammar/JSON-schema argument.

| Question type | Asks | Returns |
| --- | --- | --- |
| `Noul` | Is this true? | `noul` (0–1 probability) |
| `Choice` | Which of these options? | `choice`, `probabilities`, `confidence` |
| `Score` | Which level on a rubric? | `score`, `legend`, `probabilities`, `confidence` |

Questions are evaluated independently and in parallel; adding questions barely
changes latency. Keep each question atomic and combine answers in code.

## Integration paths

| Goal | Path | Package | Goes through OpenRouter? |
| --- | --- | --- | --- |
| Jev from OpenRouter | Decisions API (`alpha.decisions`) | `openrouter` (Python), `@openrouter/sdk` (TS) | Yes |
| Jev from LangChain | `TypeSafeClassifier` Runnable | `langchain-typesafe` (Python) | No, direct to `api.typesafe.ai` |
| Jev from TypeSafe directly | `POST /v1/systemone` | `typesafe-sdk` (Python) | No |
| Regular chat models from LangChain via OpenRouter | `ChatOpenRouter` | `langchain-openrouter` (Python) | Yes |

Two traps:

- Jev is **not** available through OpenRouter's `/api/v1/chat/completions`
  endpoint, despite OpenRouter's generic "one OpenAI-compatible API" wording.
  Chat-completions clients (`ChatOpenRouter`, OpenAI SDK) cannot call Jev. Use
  the Decisions API.
- There is **no official LangChain integration for the OpenRouter Decisions
  API**, and no LangChain JS integration for Jev. The official LangChain
  integration (`langchain-typesafe`) talks to TypeSafe directly. The supported
  pattern is to compose it with `ChatOpenRouter` in one agent.

## Environment

| Variable | Used by | Default |
| --- | --- | --- |
| `TYPESAFE_API_KEY` | `typesafe-sdk`, `langchain-typesafe` | none (required); key from `console.typesafe.ai` |
| `TYPESAFE_BASE_URL` | `typesafe-sdk`, `langchain-typesafe` | `https://api.typesafe.ai` |
| `OPENROUTER_API_KEY` | OpenRouter SDKs | none (required) |

## OpenRouter (Decisions API)

Model slugs: `typesafe/jev-1.13` (pinned) and `~typesafe/jev-latest` (alias,
moves between releases). 32K context on OpenRouter, $0.042/M input tokens,
output free, single provider (TypeSafe).

### Python

```sh
pip install openrouter
# or: uv add openrouter
```

```python
from openrouter import OpenRouter
import os

with OpenRouter(api_key=os.getenv("OPENROUTER_API_KEY", "")) as open_router:
    res = open_router.alpha.decisions.create(
        model="typesafe/jev-1.13",
        state={
            "customer_tier": "enterprise",
            "ticket": "My checkout page shows a blank screen after I click Pay.",
        },
        questions={
            "is_bug": {
                "type": "noul",
                "instructions": "Is the customer reporting a software defect?",
                "criteria": {
                    "true": "The customer describes broken or unexpected behavior.",
                    "false": "The customer is asking a question or requesting a feature.",
                },
            },
            "team": {
                "type": "choice",
                "instructions": "Which team should own this ticket?",
                "criteria": {
                    "account": "Login, permissions, or profile issues.",
                    "frontend": "Rendering, layout, or browser compatibility issues.",
                    "payments": "Checkout, billing, or payment processing issues.",
                },
            },
            "urgency": {
                "type": "score",
                "instructions": "How urgent is this ticket?",
                "criteria": [
                    "Can wait for the next release",
                    "Should be fixed this week",
                    "Blocking revenue right now",
                ],
            },
        },
    )

    print(res)
```

### TypeScript

Relevant for this repo (flint is TypeScript). Note the nested
`decisionsRequest` wrapper.

```sh
pnpm add @openrouter/sdk
```

```ts
import { OpenRouter } from "@openrouter/sdk";

const openRouter = new OpenRouter({
  apiKey: process.env["OPENROUTER_API_KEY"] ?? "",
});

async function run() {
  const result = await openRouter.alpha.decisions.create({
    decisionsRequest: {
      model: "typesafe/jev-1.13",
      state: {
        customer_tier: "enterprise",
        ticket: "My checkout page shows a blank screen after I click Pay.",
      },
      questions: {
        is_bug: {
          type: "noul",
          instructions: "Is the customer reporting a software defect?",
          criteria: {
            true: "The customer describes broken or unexpected behavior.",
            false: "The customer is asking a question or requesting a feature.",
          },
        },
        team: {
          type: "choice",
          instructions: "Which team should own this ticket?",
          criteria: {
            account: "Login, permissions, or profile issues.",
            frontend: "Rendering, layout, or browser compatibility issues.",
            payments: "Checkout, billing, or payment processing issues.",
          },
        },
        urgency: {
          type: "score",
          instructions: "How urgent is this ticket?",
          criteria: [
            "Can wait for the next release",
            "Should be fixed this week",
            "Blocking revenue right now",
          ],
        },
      },
    },
  });

  console.log(result);
}

run();
```

### Request/response shape

- `POST https://openrouter.ai/api/alpha/decisions`
- Request: `model`, `state`, `questions` (required); optional `provider`,
  `session_id`, `trace`, `user`.
- Response answers are keyed by your question IDs: Noul `{ noul }`, Choice
  `{ choice, confidence, probabilities }`, Score
  `{ score, confidence, legend, probabilities }`.
- `usage` carries `input_tokens`, `output_tokens`, `cost`.
- Retries/errors: 400, 401, 402, 403, 404, 413, 429, 500, 502, 503, 524, 529.

## LangChain (Python)

`TypeSafeClassifier` is a `Runnable` that calls TypeSafe directly (not through
OpenRouter).

```sh
uv add langchain-typesafe
# or: pip install langchain-typesafe
export TYPESAFE_API_KEY=...
```

```python
from langchain_typesafe import Choice, Noul, Score, TypeSafeClassifier

classifier = TypeSafeClassifier(
    questions={
        "urgent": Noul(instructions="Does this need attention right now?"),
        "team": Choice(
            instructions="Which team should pick this up?",
            criteria={
                "infra": "Deploys, availability, and on-call incidents.",
                "billing": "Payments, invoices, and subscriptions.",
            },
        ),
        "severity": Score(
            instructions="How severe is the impact?",
            criteria=["Cosmetic.", "Degraded for some users.", "Full outage."],
        ),
    }
)

response = classifier.invoke(
    "The deploy failed twice and customers are seeing 500s. Can someone look now?"
)

print(response.nouls["urgent"].noul)
print(response.choices["team"].choice, response.choices["team"].confidence)
print(response.scores["severity"].score)
```

- State can be a string, JSON object/array, a `BaseMessage`, or a sequence of
  messages (converted to role/content JSON, including when nested).
- Answers are grouped on `nouls`, `choices`, `scores`; the response also has
  `model`, `usage`, and `request_id`.
- `await classifier.ainvoke(...)` for async; standard Runnable batching,
  callbacks, and LangSmith tracing work.
- Constructor: `questions`, `model`, `api_key` (falls back to
  `TYPESAFE_API_KEY`), `base_url`, `timeout`, `client`, `async_client`.
- Set `TYPESAFE_BASE_URL` to route through a compatible gateway or private
  deployment.

### Experimental middleware

Requires `langchain-typesafe[experimental]`. APIs may change.

- `ModelRouterMiddleware` (`before_agent`, `wrap_model_call`) — picks which
  chat model handles the run via `ModelChoice(model=..., criteria=...)` and
  stores the result at `result["model_route"]`.
- `AutoModeMiddleware` (`wrap_tool_call`) — asks whether a listed tool call is
  too risky to run and returns an error `ToolMessage` instead of executing it.
  It refuses risky calls; it does not ask for approval, so pair it with
  human-in-the-loop middleware when a person should decide.

## Composing Jev with OpenRouter chat models in LangChain

Use `TypeSafeClassifier` (direct to TypeSafe) for decisions and `ChatOpenRouter`
for generation, composed in one agent via middleware. For regular chat models,
`ChatOpenRouter` supports structured output:

```sh
uv add langchain-openrouter
```

```python
from langchain_openrouter import ChatOpenRouter
from pydantic import BaseModel, Field

model = ChatOpenRouter(model="openai/gpt-5.5")

class Movie(BaseModel):
    title: str = Field(description="The title of the movie")
    year: int = Field(description="The year the movie was released")

structured_model = model.with_structured_output(Movie, method="json_schema")
response = structured_model.invoke("Provide details about the movie Inception")
```

This is chat-model structured output (`response_format` JSON schema), not Jev.
Do not point `TYPESAFE_BASE_URL` at OpenRouter: TypeSafe SDKs post to
`{base_url}/v1/systemone`, while OpenRouter's path and request schema differ.

## Caveats

- Type safety means answers are constrained to your declared options/types. Jev
  can still assign high confidence to a wrong-but-valid option: treat outputs
  as probabilities, set confidence thresholds, and keep a fallback path.
- `Noul` has no `confidence` (the probability is the answer). A `Noul` of 0.5
  is an even split, not "medium" — use `Score` for spectra.
- Known Jev 1.13 jaggedness: literal reading of instructions, unreliable
  counting/math and date comparison, accuracy loss with large irrelevant state,
  and sensitivity to adversarial content or contradictory instructions and
  criteria. Keep arithmetic and counting in code.
- No per-account fine-tuning. Customize through `state`, `instructions`, and
  `criteria`.
- Text-only input; English is the primary training language.
- Do not put secrets in tool arguments or conversation state sent to TypeSafe.
- `jev-latest`/`~typesafe/jev-latest` are moving aliases. Pin version IDs when
  confidence thresholds are tuned.
- Native TypeSafe context is 64k per request (state + longest question); the
  alias may report differently on OpenRouter. Output tokens are free.
- Experimental middleware and the OpenRouter Decisions endpoint are alpha
  surfaces; expect breaking changes.

## Sources

- https://docs.typesafe.ai/introduction
- https://docs.typesafe.ai/introduction/quickstart
- https://docs.typesafe.ai/models
- https://docs.typesafe.ai/api
- https://docs.typesafe.ai/sdk/python
- https://docs.langchain.com/oss/python/integrations/providers/typesafe
- https://docs.langchain.com/oss/python/integrations/chat/openrouter
- https://openrouter.ai/docs/client-sdks/python/sdks/decisions/README
- https://openrouter.ai/docs/client-sdks/typescript/sdks/decisions/README
- https://openrouter.ai/typesafe
- https://openrouter.ai/typesafe/jev-1.13
- https://openrouter.ai/~typesafe/jev-latest
