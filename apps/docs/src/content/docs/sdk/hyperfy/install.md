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
2. Open the app's settings and paste the key into **World key**.
3. Leave **Feed URL** as `https://api.vlm.gg`.

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

## Keys

- **New key** replaces the key. The old one stops working at once, so paste the new key into the app.
- **Remove** disconnects the world.

The world key is readable by anyone in the world, because Hyperfy shares app settings with every visitor. It only lets someone read the scene the world already shows and report visits. If your analytics look spammed, rotate the key.
