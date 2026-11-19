#!/bin/sh
# Downloads the offline Vosk wake-word model (Apache 2.0) into assets. Not committed (40 MB).
set -e
cd "$(dirname "$0")/app/src/main/assets"
[ -f model-en-us/uuid ] && exit 0
curl -sSLo /tmp/vosk-model.zip https://alphacephei.com/vosk/models/vosk-model-small-en-us-0.15.zip
rm -rf model-en-us vosk-model-small-en-us-0.15 && unzip -q /tmp/vosk-model.zip && mv vosk-model-small-en-us-0.15 model-en-us
echo "small-en-us-0.15" > model-en-us/uuid
