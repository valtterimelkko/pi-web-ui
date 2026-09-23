# Fix-loop freeze record

Two consecutive clean full dev-set passes (12/12 each) on the frozen revision:

- **Commit:** `f7c43bc9090a42ad8c385af3104138f8f422072b`
- **Corpus sha256:** `fb51a827483155c6f60e8fef8f048a92576af941fe6a440ce417ea827f04b5c4`
- **Voice manifests:** voice-a `1a68df3b6fdf8fe9…`, voice-b `0a72c35922285a94…`
- **Prompt sha256:** `f98c86d3f8bb8ccc586a1482416ce05260e3bb185759d52c861a3f51be258c96`
- **Scorer (verifier+director) sha256:** `608bef5797bef32aac5015f7ce1b5af7813e79fbda28d95cc6990d56beba4bd1`
- **Runner sha256:** `64c3fea91611ff9dfffe1914550f7871d1c7fdc3a72163d0491329ad3ff0cffd`

Clean passes: pass-10 and pass-11, each 12/12 (C01, C03, C05, C09, C14, C15, C16, C17, C18, C19, C20, C21) on the
standard arm through the real built app with the labelled `--tts synthetic` seam. Any post-freeze change to code,
prompt, corpus or scorer creates a new revision and re-runs affected cells explicitly (plan §8).
