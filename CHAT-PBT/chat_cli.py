import os
import sys

from dotenv import load_dotenv

GLM_BASE_URL = "https://open.bigmodel.cn/api/paas/v4"

try:
    from openai import OpenAI
except ImportError:
    print("Missing dependency: install openai with `pip install openai`.")
    sys.exit(1)


def load_config():
    load_dotenv()
    api_key = os.getenv("OPENAI_API_KEY")
    if not api_key:
        print("ERROR: OPENAI_API_KEY is not set in .env.")
        sys.exit(1)

    model = os.getenv("OPENAI_MODEL", "glm-5")
    base_url = os.getenv("OPENAI_BASE_URL")
    if not base_url and model.lower().startswith("glm-"):
        base_url = GLM_BASE_URL

    context_window = int(os.getenv("OPENAI_CONTEXT_WINDOW", "200000"))
    enable_r1 = os.getenv("OPENAI_ENABLE_R1_MESSAGES", "true").lower() in {"1", "true", "yes"}
    return api_key, base_url, model, context_window, enable_r1


def extract_response_text(response):
    choices = getattr(response, "choices", None)
    if choices:
        message = choices[0].message
        content = getattr(message, "content", None)
        if content:
            return content

    if hasattr(response, "output_text") and response.output_text:
        return response.output_text

    pieces = []
    output = getattr(response, "output", None)
    if isinstance(output, list):
        for item in output:
            if isinstance(item, dict):
                content = item.get("content")
                if isinstance(content, list):
                    for segment in content:
                        if isinstance(segment, dict):
                            pieces.append(segment.get("text", ""))
                        else:
                            pieces.append(str(segment))
                elif isinstance(content, str):
                    pieces.append(content)
            else:
                pieces.append(str(item))

    return "".join(pieces).strip()


def print_api_error(exc, base_url):
    status_code = getattr(exc, "status_code", None)
    if status_code == 401:
        print("API request failed: invalid API key.")
        print("Fix: replace OPENAI_API_KEY in .env with a new valid key.")
        if not base_url:
            print("If you are using a non-OpenAI model/provider, also set OPENAI_BASE_URL in .env.")
        print("After changing .env, restart this script.")
        return

    print(f"API request failed: {exc}")


def print_welcome(model, context_window, enable_r1):
    print("OpenAI CLI Chat")
    print("Model:", model)
    print("Context window:", f"{context_window} tokens")
    if enable_r1:
        print("Reasoning/thinking:", "enabled")
    print("Type 'exit' or 'quit' to end the session.")
    print("")


def run_chat():
    api_key, base_url, model, context_window, enable_r1 = load_config()
    client_args = {"api_key": api_key}
    if base_url:
        client_args["base_url"] = base_url
    client = OpenAI(**client_args)

    messages = [
        {
            "role": "system",
            "content": "You are a helpful assistant. Keep responses concise and friendly."
        }
    ]

    print_welcome(model, context_window, enable_r1)

    while True:
        try:
            prompt = input("You: ").strip()
        except (KeyboardInterrupt, EOFError):
            print("\nExiting chat.")
            break

        if not prompt:
            continue
        if prompt.lower() in {"exit", "quit"}:
            print("Goodbye!")
            break

        messages.append({"role": "user", "content": prompt})
        try:
            request_args = {
                "model": model,
                "messages": messages,
                "max_tokens": 1000,
                "temperature": 0.7,
            }
            if enable_r1 and model.lower().startswith("glm-"):
                request_args["extra_body"] = {
                    "thinking": {
                        "type": "enabled"
                    }
                }

            response = client.chat.completions.create(**request_args)
        except Exception as exc:
            print_api_error(exc, base_url)
            break

        assistant_text = extract_response_text(response)
        if not assistant_text:
            assistant_text = "(no response received)"

        print(f"Assistant: {assistant_text}\n")
        messages.append({"role": "assistant", "content": assistant_text})


if __name__ == "__main__":
    run_chat()
