#!/bin/bash

APP_PATH="src-tauri/target/release/bundle/macos/Excalibur.app"

if [ ! -d "$APP_PATH" ]; then
  echo "Build not found at $APP_PATH"
  echo "Run ./install.sh or cd src-tauri && cargo tauri build"
  exit 1
fi

open "$APP_PATH"
