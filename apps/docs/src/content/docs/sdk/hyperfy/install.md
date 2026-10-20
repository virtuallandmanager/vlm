---
title: Hyperfy Setup
description: Show a VLM scene in your own Hyperfy world with the VLM app.
---

The **VLM app** is a small Hyperfy app (a `.hyp` file) that shows one of your VLM scenes in a Hyperfy world you run yourself. It reads the scene from VLM and follows your edits, so you manage the scene in the dashboard and the world keeps up.

## What you need

- A plan that includes deployment (Creator and up).
- Full access to the scene you want to show.
- A self-run Hyperfy world where you can add apps.

## Connect a world

1. In the dashboard, open **Deploy** and pick the scene.
2. Under **Your Hyperfy worlds**, choose **Connect a world** and give it a name.
3. A one-time panel shows the **world key**, a **Download VLM app (.hyp)** link and the setup steps. Copy the key now: you won't see it again.

Each connected world is listed with its name, the start of its key and when it was last seen.

## Install the app

1. Drag `vlm.hyp` into your Hyperfy world.
2. Open the app's settings and paste the key into **VLM world key**.
3. Leave **VLM feed URL** as `https://api.vlm.gg`.

The scene appears within a few seconds, and later edits show up in about a second.

Moving or scaling the VLM app in Hyperfy moves or scales the whole scene in that world only. It never changes the scene in VLM.

## What renders

- **Video screens:** the live stream when the screen is live and live streaming is on. Otherwise the playlist's first video loops, or the off image shows, depending on the screen's offline mode.
- **Images**
- **3D models**
- **Sounds**
- **External links:** clicking an element with an external link opens it in a new tab.

Media Hyperfy can't play, such as gifs and webm videos, is skipped and the rest of the scene still shows.

Not yet supported: ad spaces and ad modes, NFTs, widgets and claim points.

## Analytics

Visitors show up in [VLM Analytics](/dashboard/analytics) under a **Hyperfy** location for that world. Hyperfy players have no wallets, so they count as unverified guests, and no names are recorded.

## Hosted worlds

Don't want to run Hyperfy yourself? VLM can host a world for you. Under **Create a hosted world** on the **Deploy** page, give it a name and, if you like, an end date. It is ready within a few minutes, with the VLM app already installed and showing your scene. Hosted worlds appear only where VLM has hosting turned on.

### How many you get

| Plan | Hosted worlds |
|---|---|
| Free | 0 |
| Creator | 1 |
| Pro | 3 |
| Studio | 10 |
| Enterprise | Unlimited |

A world counts from the moment you create it, whether or not anyone is in it. Worlds that have ended, worlds that failed to start and worlds you connect yourself don't count. If you downgrade and end up over your limit, your existing worlds keep running, but you can't create new ones until you're back under it. On a VLM install you run yourself with every feature unlocked, there is no limit.

### Addresses

A world's address is fixed for its life. Worlds created on Creator get `vlm-w-<name>.fly.dev`. Worlds created on Pro or higher get `<name>.worlds.vlm.gg`. The name comes from the world's name, in lowercase letters, numbers and dashes, with `-2`, `-3` and so on added if it is taken. Upgrading or downgrading never moves a world.

### Admin code

Creating a world shows its **admin code** once. In the world's chat, type `/admin <code>` to build. If you lose it, choose **Show admin code** on the world's row. Anyone with full access to the scene can do this. A world also has a world key, like a world you run yourself, which you can replace with **New key**.

### Temporary worlds

The end date is optional. Until it passes you can move it with **Edit end date**, or choose **Make permanent** to clear it. On the end date the world stops, its address stops answering and it no longer counts against your limit.

VLM keeps an ended world's data, address and key for 30 days. Choose **Restore** on its row to bring it back, as long as you have a free hosted world. After 30 days the world is deleted for good.

### Destroying a world

**Destroy** deletes the world and everything built in it, including its uploaded files and its address, straight away. It can't be restored, unlike a world that has ended.

## Keys

- **New key** replaces the key. The old one stops working at once, so paste the new key into the app.
- **Remove** disconnects the world.

The world key is readable by anyone in the world, because Hyperfy shares app settings with every visitor. It only lets someone read the scene the world already shows and report visits. If your analytics look spammed, rotate the key.
