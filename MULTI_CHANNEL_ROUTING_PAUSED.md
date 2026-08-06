Multi-channel Slack routing, paused

Branch: leads-channel-routing (PR #30)

Goal: route each form submission to its own Slack channel instead of one shared channel.

State when paused:
- Code reads per-funnel channel env vars: SLACK_CONTACT_CHANNEL, SLACK_WAITLIST_CHANNEL, SLACK_CHECKOUT_CHANNEL, SLACK_ALPHA_CHANNEL.
- Journey handler points at SLACK_ALPHA_CHANNEL (revisit).
- Per-route bot token fallbacks all fall through to CONTACT_SLACK_BOT_TOKEN.
- Vercel env vars set in Production only. Account is Pro, so Preview + Development are available; wire them next time.
- Bot confirmed in #leads-contact. Verify bot is in #leads-waitlist, #leads-checkout, #leads-alpha before shipping again.
- Proof tests updated to assert per-funnel channels.

Why paused: after merge, /api/contact threw a 502 and waitlist submissions stopped landing. Rolled back. Root cause not yet diagnosed. Suspected: response shape change after Slack post, shared import from _reserve-lib.js refactor, or a proof-test import leaking into a production path.

To resume:
1. git checkout leads-channel-routing and rebase on latest main.
2. Add all four SLACK_*_CHANNEL vars to Vercel Preview + Development.
3. Deploy to a Preview URL, test all five forms there before merging.
4. Pull the archived Vercel logs from tonight's failing deploy and diagnose the 502 before re-merging.
