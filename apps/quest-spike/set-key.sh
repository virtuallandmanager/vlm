#!/bin/sh
# Starts the Quest app with the world key from the Mac clipboard. The app saves it.
adb -d shell am start -S -n gg.vlm.spaces.quest/.MainActivity --es worldKey "$(pbpaste | tr -d '[:space:]')"
