#!/bin/bash
DIR="$(dirname "$(readlink -f "$0")")"
cd "$DIR/../../../"
node "$DIR/../dist/index.js" "$@"