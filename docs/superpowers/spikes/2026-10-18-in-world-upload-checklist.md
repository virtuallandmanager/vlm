# In-world upload — owner checklist (2026-10-18)

Run against the local setup (server :3010, web :3000, scene :8001) on branch `feature/in-world-upload`, signed in as the scene host.

1. [ ] Media Library panel shows an **Upload** button (header when the list has items, centre when it's empty).
2. [ ] **Upload** opens the Upload view: "Making a link…", then the link, the QR code, `Code: xxxxxx` and the expiry time.
3. [ ] The QR code renders as a sharp black-and-white square (if it's blank, note it: the typed link still works).
4. [ ] The ✓ ⟳ ✕ marks render in badges (if they show as boxes, tell me and I'll switch to dots).
5. [ ] **Open on this computer** shows Decentraland's open-link prompt, then the upload page with "10 uploads remaining".
6. [ ] Upload a PNG from the computer: the page shows a progress bar then Done; the HUD row goes • Uploading → • Processing → ✓ Available without reopening the panel.
7. [ ] **Place** the new image: it appears 2 m in front of you.
8. [ ] Scan the QR with an iPhone: the upload page opens with the right code.
9. [ ] Upload an iPhone photo: it lands as a JPEG (or a clear "HEIC isn't supported" message).
10. [ ] Same from an Android phone, if you have one handy.
11. [ ] Upload a GLB: it shows ✓ Available; **Place** it, and the badge flips to ⟳ Needs sync (plus the sync notice).
12. [ ] Pick a file over 10 MB (image): the page shows "too big" and nothing shows in the HUD, or the row shows ✕ Failed with the reason; **Dismiss** clears it.
13. [ ] **New link** gives a different code; the old QR still works until it expires.
14. [ ] A second editor in the scene sees your uploads appear live.
15. [ ] A viewer (non-editor) sees no Upload button and gets no upload rows.
16. [ ] Closing the panel and reopening it shows the list again (the old link is forgotten; Upload makes a new one).
