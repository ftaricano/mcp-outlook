# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is an MCP (Model Context Protocol) server for Microsoft Graph email integration that provides comprehensive email management capabilities for Claude Code. The server connects to Microsoft Outlook/Exchange via Microsoft Graph API and exposes 11 different tools for email operations including reading, sending, managing attachments, and intelligent email summarization.

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
- `EmailService`: Core email operations (CRUD, search, attachments)
- `EmailSummarizer`: Intelligent email analysis with priority detection, categorization, and sentiment analysis

### Key Architectural Patterns

**Dual Authentication Strategy**: Service supports both `me` (service account) and specific user email targeting via `TARGET_USER_EMAIL` environment variable.

**Rich Email Analysis**: The summarizer implements sophisticated business logic for email categorization (Meeting, Project, Financial, HR, Marketing, Support, Sales, Notification) with priority scoring and sentiment analysis.

**Attachment Management**: Complete attachment lifecycle from listing to Base64 content download.

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

The server exposes 11 tools categorized by functionality:

**Email Management**: `list_emails`, `send_email`, `reply_to_email`
**Status Operations**: `mark_as_read`, `mark_as_unread`, `delete_email`
**Attachment Operations**: `list_attachments`, `download_attachment`
**Analysis Tools**: `summarize_email`, `summarize_emails_batch`
**User Management**: `list_users`

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