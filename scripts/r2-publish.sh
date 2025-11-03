#!/bin/bash

# Get version from package.json
VERSION=$(node -p "require('./package.json').version")
TARGET_DIR="../r2-asset-proxy/static/wavedash-sdk"

# Copy latest.js and map
cp dist/index.global.js "$TARGET_DIR/latest.js"
cp dist/index.global.js.map "$TARGET_DIR/latest.js.map"

# Copy versioned files
cp dist/index.global.js "$TARGET_DIR/$VERSION.js"
cp dist/index.global.js.map "$TARGET_DIR/$VERSION.js.map"

# Fix sourceMappingURL in both files
sed -i '' "s/sourceMappingURL=index.global.js.map/sourceMappingURL=latest.js.map/g" "$TARGET_DIR/latest.js"
sed -i '' "s/sourceMappingURL=index.global.js.map/sourceMappingURL=$VERSION.js.map/g" "$TARGET_DIR/$VERSION.js"

echo "Published SDK to $TARGET_DIR:"
echo "  - latest.js"
echo "  - $VERSION.js"
