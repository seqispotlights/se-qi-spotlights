# Google Apps Script Trigger

1. Create a standalone project at `script.google.com` and paste `Code.gs` into it.
2. In **Project Settings > Script Properties**, add `GITHUB_TOKEN` with a fine-grained PAT limited to `seqispotlights/se-qi-spotlights` and **Actions: Read and write**.
3. Run `testGitHubTriggerOnce` and approve the Apps Script authorization prompts.
4. Confirm a `workflow_dispatch` run appears for **Publish SE-QI Spotlights**.
5. Run `setupFiveMinuteTrigger` once. It creates one five-minute trigger and removes accidental duplicates for the same handler.

No web-app deployment is required. Keep the token only in Script Properties; never paste it into the code or repository.
