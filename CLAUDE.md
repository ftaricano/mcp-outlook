# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is an advanced MCP (Model Context Protocol) server for Microsoft Graph email integration that provides comprehensive email management capabilities for Claude Code. The server connects to Microsoft Outlook/Exchange via Microsoft Graph API and exposes 15 different tools for email operations including reading, sending, managing attachments, intelligent email summarization, and **hybrid functions that solve MCP protocol limitations for large file handling**.

## Architecture

### Core Components

The application follows a clean layered architecture:

**Entry Point (`src/index.ts`)**
- `EmailMCPServer` class orchestrates all MCP tool handlers
- Handles tool registration and request routing
- Implements comprehensive error handling with Portuguese error messages

**Authentication Layer (`src/auth/graphAuth.ts`)**
- `GraphAuthProvider` implements Microsoft Graph authentication
- Uses Azure MSAL (Microsoft Authentication Library) with Client Credentials flow
- Manages token lifecycle with automatic refresh
- Supports both user-specific and service account authentication patterns

**Service Layer (`src/services/`)**
- `EmailService`: Core email operations (CRUD, search, attachments) with new hybrid functions
- `EmailSummarizer`: Intelligent email analysis with priority detection, categorization, and sentiment analysis
- `FileManager`: Optimized file handling for large attachments with disk-based processing

### Key Architectural Patterns

**Dual Authentication Strategy**: Service supports both `me` (service account) and specific user email targeting via `TARGET_USER_EMAIL` environment variable.

**Rich Email Analysis**: The summarizer implements sophisticated business logic for email categorization (Meeting, Project, Financial, HR, Marketing, Support, Sales, Notification) with priority scoring and sentiment analysis.

**Attachment Management**: Complete attachment lifecycle from listing to Base64 content download.

**Hybrid Functions Architecture**: Revolutionary approach that solves MCP protocol limitations for large file transfers:
- `sendEmailFromAttachment()`: Downloads attachment from source email → processes on disk → sends with new email
- `sendEmailWithFileAttachment()`: Reads file from disk → encodes internally → sends without MCP Base64 transfer
- `FileManager`: Handles large file operations with disk-based processing, avoiding memory limitations

## Development Commands

### Build & Run
```bash
npm run build          # Compile TypeScript to dist/
npm start              # Run compiled server
npm run dev            # Development mode with watch
```

### Testing & Validation
```bash
node test-connection.js      # Test Microsoft Graph connectivity
node test-email-functions.js # Test specific email operations
node check-permissions.js    # Validate Azure AD permissions
```

## Configuration Requirements

### Environment Variables (.env)
```env
MICROSOFT_GRAPH_CLIENT_ID=your_client_id_here
MICROSOFT_GRAPH_CLIENT_SECRET=your_client_secret_here
MICROSOFT_GRAPH_TENANT_ID=your_tenant_id_here
TARGET_USER_EMAIL=user@domain.com  # Optional: specific user targeting
```

### Required Azure AD Permissions
- `Mail.ReadWrite` - Email management operations
- `Mail.Send` - Sending new emails  
- `User.Read.All` - User directory access

## Available MCP Tools

The server exposes 15 tools categorized by functionality:

**Email Management**: `list_emails`, `send_email` (with attachment support), `reply_to_email`
**Status Operations**: `mark_as_read`, `mark_as_unread`, `delete_email`
**Basic Attachment Operations**: `list_attachments`, `download_attachment`
**Advanced Attachment Operations**: `download_attachment_to_file`, `encode_file_for_attachment`, `export_email_as_attachment`
**Hybrid Functions (NEW)**: `send_email_from_attachment`, `send_email_with_file`
**Analysis Tools**: `summarize_email`, `summarize_emails_batch`
**User Management**: `list_users`

### Enhanced Email Sending with Attachments

The `send_email` tool now supports sending attachments with the following features:
- **Multiple Attachment Support**: Send multiple files in a single email
- **Base64 Content Encoding**: Secure file content transmission via Base64 encoding
- **MIME Type Support**: Automatic content type detection and specification
- **File Size Tracking**: Optional file size metadata for better handling
- **Comprehensive Error Handling**: Detailed error messages for attachment processing failures

#### Attachment Format:
```json
{
  "name": "document.pdf",
  "contentType": "application/pdf", 
  "content": "base64EncodedContent...",
  "size": 1024 // optional, in bytes
}
```

### Hybrid Functions - Solving MCP Protocol Limitations

#### `send_email_from_attachment`
Revolutionary function that completely automates email forwarding with large attachments:

**Process Flow:**
1. Downloads attachment from source email using `downloadAttachmentToFile()`
2. Saves file directly to disk (bypassing MCP memory limitations)
3. Re-encodes file using `FileManager.encodeFileForEmailAttachment()`
4. Sends new email with attachment via Microsoft Graph API
5. Optionally cleans up temporary files

**Key Benefits:**
- No MCP protocol size limitations (handles files up to 3MB Microsoft Graph limit)
- Automatic file validation and integrity checking
- Optimized disk-based processing
- Complete error handling and recovery

#### `send_email_with_file`
Direct file-to-email function for disk-based files:

**Process Flow:**
1. Reads file from local disk using `FileManager`
2. Performs MIME type detection and validation
3. Encodes to Base64 internally (no MCP transfer)
4. Sends email with attachment via Microsoft Graph API

**Use Cases:**
- Automated reporting with generated files
- Bulk email operations with pre-processed attachments
- Integration with other systems that generate files locally

## Email Summarization System

The intelligent summarizer analyzes emails across multiple dimensions:

- **Priority Detection**: Alta/Média/Baixa based on urgency keywords
- **Category Classification**: 8 business categories with keyword matching
- **Sentiment Analysis**: Positive/Neutral/Negative sentiment scoring
- **Action Requirements**: Detects emails requiring user response
- **Key Information Extraction**: Dates, monetary values, bullet points
- **Attachment Awareness**: Lists and categorizes attached files

## Error Handling Patterns

The codebase implements comprehensive error handling:
- All service methods use try/catch with specific error messaging
- Portuguese error messages for user-facing responses
- Graceful degradation for batch operations (continues processing if individual items fail)
- Authentication token refresh on expiration

## Integration Notes

When integrating with Claude Code, the server uses stdio transport and expects to be configured in Claude Code's MCP server settings with proper environment variable configuration for Azure AD authentication.

## File Structure Context

```
src/
├── auth/graphAuth.ts        # Microsoft Graph authentication provider
├── services/
│   ├── emailService.ts      # Core email operations and Microsoft Graph API integration
│   └── emailSummarizer.ts   # Intelligent email analysis and summarization
└── index.ts                 # MCP server entry point and tool handlers
```

The TypeScript configuration uses ES2022 with ESNext modules, compiling to `dist/` directory with source maps and declarations for debugging support.