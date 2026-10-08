#!/bin/sh
set -eu

node -e "fetch('http://127.0.0.1:3000/readyz').then(response => process.exit(response.ok ? 0 : 1)).catch(() => process.exit(1))"
