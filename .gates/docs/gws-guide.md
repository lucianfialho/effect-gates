# Google Workspace CLI (gws) — Agent Reference

## Authentication
Already configured. Run commands directly — no login needed.

---

## Listing Meetings

```bash
gws meet conferenceRecords list
```

Response format:
```json
{
  "conferenceRecords": [
    {
      "name": "conferenceRecords/ABC123",
      "startTime": "2026-05-08T17:59:02Z",
      "endTime": "2026-05-08T18:59:18Z",
      "space": "spaces/XYZ"
    }
  ]
}
```

To get more results:
```bash
gws meet conferenceRecords list --params '{"pageSize": 50}'
```

---

## Getting Transcripts

### Step 1 — List transcript IDs for a meeting:
```bash
gws meet conferenceRecords transcripts list \
  --params '{"parent": "conferenceRecords/ABC123"}'
```

Response:
```json
{
  "transcripts": [
    {
      "name": "conferenceRecords/ABC123/transcripts/TR456",
      "state": "APPLIED"
    }
  ]
}
```

Only use transcripts with `"state": "APPLIED"` — others are incomplete.

### Step 2 — Get the actual spoken text:
```bash
gws meet conferenceRecords transcripts entries list \
  --params '{"parent": "conferenceRecords/ABC123/transcripts/TR456"}' \
  --page-all
```

Response:
```json
{
  "transcriptEntries": [
    {
      "name": "conferenceRecords/ABC123/transcripts/TR456/entries/001",
      "participant": "participants/USER1",
      "startTime": "2026-05-08T18:02:00Z",
      "endTime": "2026-05-08T18:02:15Z",
      "text": "The actual spoken words from the meeting"
    }
  ]
}
```

Use `--page-all` to get all entries (meetings can have hundreds).

---

## Getting Participants

```bash
gws meet conferenceRecords participants list \
  --params '{"parent": "conferenceRecords/ABC123"}'
```

Response:
```json
{
  "participants": [
    {
      "name": "participants/USER1",
      "earliestStartTime": "2026-05-08T17:59:02Z",
      "latestEndTime": "2026-05-08T18:59:18Z",
      "signedinUser": {
        "user": "users/lucian@metricasboss.com.br",
        "displayName": "Lucian"
      }
    }
  ]
}
```

---

## Calendar

```bash
# Upcoming events
gws calendar +agenda --week

# Search for specific events
gws calendar events list \
  --params '{"calendarId": "primary", "q": "Q&A", "maxResults": 10}'
```

---

## Full Pipeline: Meeting → Issues

```bash
# 1. List recent meetings
gws meet conferenceRecords list --params '{"pageSize": 20}'

# 2. Get transcript IDs (use the conferenceRecord name from step 1)
gws meet conferenceRecords transcripts list \
  --params '{"parent": "conferenceRecords/RECORD_ID"}'

# 3. Get all transcript text (use transcript name from step 2)
gws meet conferenceRecords transcripts entries list \
  --params '{"parent": "conferenceRecords/RECORD_ID/transcripts/TRANSCRIPT_ID"}' \
  --page-all

# 4. Create GitHub issue from extracted action item
gh issue create \
  --repo ORG/REPO \
  --title "Action item title" \
  --body "Context from meeting" \
  --label "meeting-action-item"
```

---

## Tips

- Meeting IDs look like: `conferenceRecords/7957o-Xg93GumtFcHy_7DxIUOAIIigIgABgFCA`
- Transcript IDs look like: `conferenceRecords/ID/transcripts/TR_ID`
- Use `--page-all` for long transcripts
- Filter meetings by date using startTime field
- Names of spaces/participants are opaque IDs — get display names from participants endpoint
