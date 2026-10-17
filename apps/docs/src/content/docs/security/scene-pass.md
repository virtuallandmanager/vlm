---
title: Scene pass and scene library
description: What a scene can do with a visitor's VLM sign-in, and who owns the files in a scene's library.
---

## What a scene pass is
When you sign in from inside Decentraland, VLM gives you a scene pass. It lets you act as yourself, but only inside the scene set up at the parcel or World where you're standing.

- **The scene set up at your location:** you have your usual role in that scene, such as editing from the HUD.
- **A parcel or World with no setup:** you're a visitor only. You can see content, but you can't edit and you can't open Stats.
- **Any scene trying to act for you elsewhere:** it can't. Other scenes see you only as an anonymous visitor in their own content.

## Signing in on the website
A scene pass opens only that scene's analytics on the website. Anything else asks you to sign in with full access. See [Analytics](/dashboard/analytics/#signing-in-from-the-hud) for how the Stats button works.

The first time you open the website after this upgrade, you're signed out once. Sign in as usual and you're back to normal.

## The scene library
Each scene has one shared library of files.

- **Uploads from the HUD:** editors and above can upload. Files are stored in the scene owner's account and count against the owner's storage. If the owner's storage is full, the upload is refused with "The scene owner's storage is full".
- **Adding existing files:** owners can add files from their own library to a scene's library. This is available through the API with an account sign-in, so tools and integrations can use it. There is no button for it on the website yet.
- **Removing items:** hosts and co-hosts can remove any item. Editors can remove only the items they added. Removing an item takes it out of the library but never deletes the file.

Files that were already placed in your scenes were added to the library automatically, if they were your own files or public catalog models.

## Renters
During an active booking, the renter uploads into their own account. So do crew whose access covers screens, playlist or audio. Their items show in the scene library only while the booking is active.
