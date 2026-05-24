# Runtime Directory

This directory contains bundled runtime dependencies for offline installation.

## Structure

```
runtime/
├── node/                    # Node.js runtime
│   ├── win-x64/            # Windows x64
│   ├── darwin-x64/         # macOS Intel
│   └── darwin-arm64/       # macOS Apple Silicon
└── git/                     # Git portable (Windows only)
    └── win-x64/            # MinGit for Windows
```

## How to Download

Run the download script before building:

```bash
npm run download-runtime
```

Or it will be automatically downloaded during `npm install` via postinstall hook.

## Mirror Sources (China)

The download script uses npmmirror.com by default for faster downloads in China.
