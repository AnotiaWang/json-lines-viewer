# Change Log

All notable changes to the "json-lines-viewer" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [Unreleased]

## [0.1.0] - 2025-04-20

### Added
- **Line Editing**: Added the ability to edit individual lines of a JSONL file.
  - Opening the preview now creates a temporary, editable `.json` file for the selected line.
  - Saving the temporary file writes the (validated and single-lined) JSON content back to the original file.
- **Automatic Cleanup**: Temporary files are automatically deleted when their editor tab is closed. Leftover temporary files/directories are cleaned up on extension activation (e.g., VS Code startup/reload).
- **Context-Aware Navigation**: Editor title bar navigation buttons (Previous/Next/Go To Line) now only appear and are enabled when viewing the temporary edit file.

### Changed
- The "Open JSON Lines Preview" command now opens an editable temporary file instead of a read-only preview.

### Fixed
- Improved multi-window safety by removing aggressive startup cleanup that could delete files used by other windows.
- Fix path error when opening preview from explorer context menu (previously unreleased fix included here).

## [0.0.4] - (Date of 0.0.4 release if known)
- Fix path error in Linux

## [0.0.3] - (Date of 0.0.3 release)
- Fix path error in Windows

## [0.0.2] - (Date of 0.0.2 release)
- Update Readme and instructions

## [0.0.1] - (Date of 0.0.1 release)
- Initial release