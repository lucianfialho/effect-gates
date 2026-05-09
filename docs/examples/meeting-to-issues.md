# Meeting → Issues

Convert Google Meet transcripts into GitHub Issues automatically using the `meeting-issues` harness.

## How it works

```
Google Meet recording
  → gws meet conferenceRecords transcripts entries list   (get transcript)
  → LLM: extract action items → JSON                      (structure data)
  → gh issue create ...                                    (create issues)
```

The agent does NOT write code — it creates structured tickets. Your DevPipeline picks them up from there.

## Setup

### 1. Google Workspace CLI

```bash
npm install -g @googleworkspace/cli
gws auth login
gws auth export --unmasked > ~/.gates/google-credentials.json
```

### 2. GitHub token

```bash
export GH_TOKEN=ghp_...
# or: gh auth login
```

### 3. Environment variables

```bash
export GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE=~/.gates/google-credentials.json
export ANTHROPIC_API_KEY=sk-ant-...
```

## Usage

```bash
harness-ui --dir /your/project
# → select "Meeting Issues"
```

**Step 1 — list recent meetings:**
```
/skill list-meetings
```

**Step 2 — extract action items:**
```
/skill extract-action-items conference_id=<id> transcript_id=<id> repo=org/repo
```

The sidebar populates automatically with extracted items.

**Step 3 — create issues:**
```
/skill create-github-issues repo=org/repo title="..." description="..." meeting_title="Team Standup"
```

## Connector structure

```yaml
# .gates/connectors/google-workspace/connector.yaml
commands:
  - name: gws_meet
    executable: gws
    allowedSubcommands: [meet]
    env:
      GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE: "{{credentials.GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE}}"

# .gates/connectors/github/connector.yaml
commands:
  - name: gh
    executable: gh
    allowedSubcommands: [issue, pr, repo]
    env:
      GH_TOKEN: "{{credentials.GH_TOKEN}}"
```

## Skill: extract-action-items

The skill fetches the transcript via `gws_meet`, then sends it to the LLM with a structured prompt that returns JSON:

```json
[
  {
    "title": "Fix authentication bug on mobile",
    "description": "Auth failing after recent deploy — see logs from standup",
    "assignee": "lucian",
    "priority": "high",
    "labels": ["meeting-action-item", "bug"]
  }
]
```

The sidebar in harness-ui auto-populates from this output when the skill completes.

## Why no code execution?

The agent's job is **ideation and structuring**, not execution. Creating well-formed tickets with enough context for autonomous execution is the valuable part. The DevPipeline handles the rest.

This separation also makes it easy to add human review between ideation and execution.
