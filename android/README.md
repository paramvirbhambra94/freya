# FREYA Android shell

Kotlin app that wraps https://freya-black.vercel.app in a WebView and adds:
- Offline wake word "Freya" (Vosk small English model, grammar-limited, no API key) in a microphone foreground service; opens FREYA over the lock screen and auto-starts talking (`/?wake=1`).
- Exact alarms (`setAlarmClock`) with a full-screen alarm over the lock screen, dismiss/snooze, survive reboot.
- JS bridge `window.FreyaAndroid` (setAlarm/cancelAlarm/listAlarms/sessionActive/setWakeWord/openSettings), only while the FREYA site is loaded.
- Passkeys in the WebView via AndroidX WebKit WebAuthn support + `/.well-known/assetlinks.json`.

Build (on the box): `./fetch-model.sh && ./gradlew assembleRelease`.
Signing reads `/home/box/freya-secrets/keystore.properties` (or `$FREYA_KEYSTORE_PROPS`). Secrets are never committed.
Download: https://freya-black.vercel.app/app (latest GitHub Release asset).
