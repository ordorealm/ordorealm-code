!ifdef BUILD_UNINSTALLER
  ; Disable CRC check for uninstaller — required when cross-compiling
  ; from macOS/Linux where code-signing modifies the uninstaller binary
  ; after NSIS embeds the CRC checksum.
  CRCCheck off
!endif
