"""Test the OpenAI-compatible HTTP fallback for Code Agent proposal.
API key is read from env var JAVIS_OPENCODE_LIVE_API_KEY."""
import json, os, sys, hashlib, urllib.request, urllib.error

API_KEY = os.environ.get("JAVIS_OPENCODE_LIVE_API_KEY", "")
if not API_KEY:
    print("ERROR: Set JAVIS_OPENCODE_LIVE_API_KEY environment variable")
    sys.exit(1)

BASE_URL = os.environ.get("JAVIS_OPENCODE_LIVE_BASE_URL", "https://api.deepseek.com")
MODEL = os.environ.get("JAVIS_OPENCODE_LIVE_MODEL", "deepseek-chat")
ENDPOINT = f"{BASE_URL}/chat/completions"

# Read prompt from adjacent file
prompt_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "proposal-prompt.txt")
with open(prompt_path, "r", encoding="utf-8") as f:
    prompt_text = f.read()

# Same prefix as Rust code uses
TERMINOLOGY_PREFIX = """Javis terminology rules for Chinese output:
- Agent: keep the English term; do not translate it as proxy or bot.
- Token: keep the English term.
- confirmed write: confirmed write = user-approved write operation.
- dry run: dry run = preview execution without modifying files.
- patch: patch = code/file change proposal, not a repair program.
- hunk: hunk = one changed section in a unified diff.
- diff: diff = unified/text difference.
- workspace: workspace = working directory.
- approval: approval = user permission decision.
- proposal: proposal = proposed change.
- verifier: verifier = validation role.
- Commander: keep Commander as an English role name.
Keep JSON keys, code, paths, commands, and identifiers unchanged."""

full_prompt = f"{TERMINOLOGY_PREFIX}\n\n{prompt_text}"

body = {
    "model": MODEL,
    "messages": [
        {"role": "system", "content": "Return only the requested JSON object. Do not include markdown fences or explanation."},
        {"role": "user", "content": full_prompt}
    ],
    "stream": False,
    "temperature": 0,
    "max_tokens": 4096,
    "thinking": {"type": "disabled"},
    "response_format": {"type": "json_object"}
}

print(f"Endpoint: {ENDPOINT}")
print(f"Model: {MODEL}")
print(f"Prompt length: {len(full_prompt)} chars")
print(f"API key: sk-...{API_KEY[-4:]}")

req = urllib.request.Request(
    ENDPOINT,
    data=json.dumps(body).encode("utf-8"),
    headers={"Authorization": f"Bearer {API_KEY}", "Content-Type": "application/json"},
    method="POST"
)

try:
    with urllib.request.urlopen(req, timeout=30) as resp:
        data = json.loads(resp.read().decode("utf-8"))
        content = data["choices"][0]["message"]["content"]
        usage = data.get("usage", {})
        print(f"\nHTTP {resp.status} | Tokens: {usage.get('total_tokens', '?')} | Model: {data.get('model', '?')}")

        # Parse as proposal
        proposal = json.loads(content)
        patch = proposal.get("patch", "")
        errors = []
        if not proposal.get("summary"): errors.append("missing summary")
        if not isinstance(proposal.get("changedFiles"), list) or not proposal["changedFiles"]: errors.append("missing changedFiles")
        if not patch: errors.append("missing patch")
        if "src/message.txt" not in proposal.get("changedFiles", []): errors.append("wrong file in changedFiles")

        print(f"Summary: {proposal.get('summary', 'MISSING')}")
        print(f"ChangedFiles: {proposal.get('changedFiles', [])}")
        print(f"Patch hash: {hashlib.sha256(patch.encode()).hexdigest()[:16]}")
        print(f"Patch length: {len(patch)}")

        if errors:
            print(f"\nFAIL: {errors}")
            sys.exit(1)
        print("\nPASS: Valid proposal generated via HTTP fallback")
except urllib.error.HTTPError as e:
    body_text = e.read().decode("utf-8")[:500]
    print(f"\nHTTP ERROR {e.code}: {body_text}")
    sys.exit(1)
except Exception as e:
    print(f"\nERROR: {e}")
    sys.exit(1)
