# yahoo-mcp-connector

A custom connector that lets Claude (and Duet) review and act on email in a Yahoo Mail account.
It is an [MCP](https://modelcontextprotocol.io) server that talks to Yahoo over IMAP (reading) and, later, SMTP (sending).

## Status

| Step | What | State |
|---|---|---|
| 1 | Yahoo app password | Done (kept by the account owner, never in this repo) |
| 2 | Local, read-only server tested with MCP Inspector | Done |
| 3 | Action tools: draft, send, move, flag, delete | Done |
| **4** | **HTTPS transport and Cognito sign-in** | **This step** |
| 5 | Deploy to AWS Lambda | Next |
| 6 | Add as a custom connector in Claude | |
| 7 | Test on desktop and in Duet | |

## Tools

**Reading** (folders are opened read-only; reading never marks a message as read)

| Tool | What it does |
|---|---|
| `list_folders` | Lists folders with total and unread counts |
| `search_mail` | Searches one folder by sender, recipient, subject, text, date range, unread or flagged. Newest first, up to 50 results |
| `read_message` | Reads one message by `uid`: headers, plain-text body, attachment names |

**Acting**

| Tool | What it does |
|---|---|
| `create_draft` | Saves a new email or reply to Drafts. Sends nothing |
| `send_email` | **Preview only.** Prepares a new email, a reply (`replyToUid`), or a saved draft (`draftUid`) and returns a preview plus a one-time code |
| `delete_message` | **Preview only.** Shows which message would go to Trash and returns a one-time code |
| `confirm_action` | Carries out the send or delete for a code. The only tool that sends or deletes |
| `move_message` | Moves a message to another folder (returns its new `uid`) |
| `archive_message` | Moves a message to Archive |
| `mark_message` | Read/unread and flagged/unflagged |

## Safety design

1. **Preview, then confirm.** `send_email` and `delete_message` never act. They store exactly what would happen under a random one-time code (valid 10 minutes) and return a preview. `confirm_action` takes *only* the code, so what runs is exactly what was previewed, and each code works once. The tool descriptions tell Claude to show you the preview and wait for your clear OK before confirming.
2. **Claude's own approval prompt.** Each tool is labeled read-only, changing, or destructive (`confirm_action`). Claude apps use those labels to decide when to ask you before running a tool.
3. **Daily send limit.** The server refuses to send more than `MAX_SENDS_PER_DAY` (default 20) emails per day, whatever the AI asks.
4. **No permanent deletes.** Delete means "move to Trash", so anything can be recovered. The one exception: after a saved draft is sent, that draft is removed from Drafts, as Yahoo Mail itself does.

Limits for now: emails are plain text, attachments can't be added, and a draft with attachments must be sent from Yahoo Mail.

The preview codes and send counter are kept in memory. That's right for the local server; Step 5 moves them to a DynamoDB table so they survive on AWS Lambda.

## How the code is organised

```
src/
  config.ts    Reads settings from the environment (.env locally)
  imap.ts      Opens a TLS connection to imap.mail.yahoo.com:993, runs one job, closes it
  tools.ts     The three reading tools
  body.ts      Picks readable body text, converting HTML when the plain-text part is empty
  actions.ts   The acting tools, including preview/confirm
  pending.ts   One-time codes and the daily send counter
  compose.ts   Builds emails and works out reply recipients and threading headers
  folders.ts   Finds Yahoo's Drafts, Sent, Trash and Archive folders
  smtp.ts      Sends through smtp.mail.yahoo.com:465 (TLS)
  server.ts    Builds the MCP server with all ten tools
  index.ts     Local entry point over stdio (no sign-in; only your computer can reach it)
  auth.ts      Cognito sign-in: checks tokens and describes the login server to Claude
  app.ts       HTTPS entry point: /mcp plus the sign-in discovery documents
  http.ts      Runs app.ts on localhost for testing
test/          Unit tests (run with `npm test`)
```

Both entry points build the same server from `server.ts`, so the tools behave identically locally and on AWS.

## What gets installed, and why

| Package | Why |
|---|---|
| `@modelcontextprotocol/sdk` | Official MCP toolkit: handles the protocol between Claude and this server |
| `imapflow` | IMAP client used to read the mailbox |
| `mailparser` | Turns a raw email into headers, text and attachment info |
| `html-to-text` | Converts HTML-only emails (receipts, newsletters) to readable text |
| `nodemailer` | Builds emails and sends them through Yahoo's SMTP server |
| `express` | Web server framework for the HTTPS endpoint |
| `aws-jwt-verify` | AWS's official library for checking Cognito tokens |
| `zod` | Validates the inputs Claude sends to each tool |
| `dotenv` | Loads your `.env` file when running locally |
| `typescript`, `tsx`, `@types/*` | Dev only: compile and run TypeScript |

`npm install` puts these in `node_modules/`, which is ignored by Git.

## Run it on your computer

**1. Install Node.js 20 or newer.** Check with `node -v`. If it's missing, install the LTS version from [nodejs.org](https://nodejs.org).

**2. Get the code.**
```bash
git clone https://github.com/trexx00/yahoo-mcp-connector.git
cd yahoo-mcp-connector
git checkout step-4-http-oauth   # until this step is merged
npm install
```

**3. Add your Yahoo details to a local `.env` file.**
```bash
cp .env.example .env
```
Open `.env` in a text editor and fill in `YAHOO_EMAIL` and `YAHOO_APP_PASSWORD` (spaces in the app password are fine).
`.env` is listed in `.gitignore`, so Git will never upload it. Don't paste these values anywhere else.

**4. Open the MCP Inspector.**
```bash
npm run inspect
```
This downloads and starts the [MCP Inspector](https://github.com/modelcontextprotocol/inspector), which starts this server and opens a page in your browser. Then:
1. Click **Connect**.
2. Open the **Tools** tab and click **List Tools**. You should see the three tools.
3. Run `list_folders`. You should see your folders, such as `Inbox`, `Sent`, `Archive`.
4. Run `search_mail` with `unreadOnly` checked, or a `from` value.
5. Copy a `uid` from the results and run `read_message` with it.
6. Check in Yahoo Mail that the message you read is still unread.

**Testing the acting tools (Step 3).** Use only your own address, or a test email you don't mind changing:

1. `create_draft` with `to` = your own address, a `subject` and `body`. Check it appears in Yahoo's **Drafts**.
2. `send_email` with the same kind of values. Check the result says **NOT SENT YET** and gives a `confirmationCode`. Nothing should arrive.
3. `confirm_action` with that code. The email should arrive in your Inbox. Run `confirm_action` with the same code again: it must be refused.
4. Look in **Sent**. If the email is there **twice**, set `SAVE_SENT_COPY=false` in `.env`.
5. Reply: `search_mail` to find the email you sent yourself, then `send_email` with `replyToUid` and a `body`, then `confirm_action`. The reply should show up in the same conversation in Yahoo.
6. Send a saved draft: `search_mail` with `folder` set to your Drafts path, then `send_email` with `draftUid`, then `confirm_action`. The draft should leave Drafts.
7. `mark_message` with `read: false` and `flagged: true`, and check in Yahoo.
8. `move_message` to another folder, then `archive_message`.
9. `delete_message`, then `confirm_action`. The message should be in **Trash**, not gone.

Press `Ctrl+C` in the terminal to stop.

## How sign-in works (Step 4)

```
Claude ──(1) POST /mcp, no token──────────────▶ this server ──▶ 401 + "sign-in info is here"
Claude ──(2) reads /.well-known/... ───────────▶ this server ──▶ "log in at Cognito, PKCE required"
Claude ──(3) opens Cognito login page ─────────▶ Cognito  (you: username, password, MFA code)
Cognito ─(4) access token ─────────────────────▶ Claude
Claude ──(5) POST /mcp + token ────────────────▶ this server checks the token, then runs the tool
```

The server never sees your Cognito password. It only checks that each token was signed by **your** user pool, issued to **your** app client, is an access token, and hasn't expired. Self sign-up is off, so the only account that can ever log in is the one you create.

## Set up Cognito (AWS console, region us-east-2)

You do these steps yourself. Nothing here is a secret to paste into chat. The pool ID, client ID and domain are identifiers, and your password and MFA stay with you.

**1. Create the user pool**
1. Open the AWS console, check the region (top right) says **US East (Ohio) us-east-2**, and go to **Amazon Cognito**.
2. Click **Create user pool**. On the setup screen:
   - **Application type:** *Single-page application (SPA)*. This makes a public app client with no secret, which is what Claude needs with PKCE.
   - **Name your application:** `claude-yahoo-mail`
   - **Options for sign-in identifiers:** *Username*
   - **Self-registration:** leave **unchecked**. This keeps strangers from creating accounts.
   - **Return URL:** `https://claude.ai/api/mcp/auth_callback`
3. Click **Create user directory**.

**2. Check the feature plan (cost).** Open the pool and go to **Settings → Feature plan**. *Lite* or *Essentials* both work for us. Check the free monthly-active-user allowance shown on that page. One user should cost nothing, but confirm before continuing.

**3. Require MFA.** Go to **Authentication → Sign-in → Multi-factor authentication → Edit**. Choose **Require MFA**, tick **Authenticator apps**, and save.

**4. Configure the app client.** Go to **Applications → App clients → claude-yahoo-mail**.
- On the **Login pages** tab, click **Edit** and set:
  - **Allowed callback URLs:** `https://claude.ai/api/mcp/auth_callback`, `http://localhost:6274/oauth/callback` and `http://localhost:6274/oauth/callback/debug` (the last two are for the MCP Inspector)
  - **OAuth 2.0 grant types:** *Authorization code grant* only
  - **OpenID Connect scopes:** *OpenID* (untick the others)
- Under **App client information → Edit**, set the access token to **1 hour** and the refresh token to **30 days**.

**5. Note the login domain.** Go to **Branding → Domain**. If there's no domain yet, create a **Cognito domain** with a prefix like `yahoo-mcp-<something-unique>`. Copy the full domain, e.g. `https://yahoo-mcp-tj.auth.us-east-2.amazoncognito.com`.

**6. Create your user.** Go to **User management → Users → Create user**. Pick a username and set a strong temporary password. You'll change it, and set up your authenticator app, the first time you log in.

**7. Put the identifiers in `.env`** on your computer: `COGNITO_USER_POOL_ID` (Overview page), `COGNITO_CLIENT_ID` (App client page) and `COGNITO_DOMAIN` (step 5). See `.env.example`.

## Test sign-in on your computer

1. `npm install`, then `npm run dev:http`. It should print `listening at http://localhost:3000/mcp`.
2. In a second terminal, run `npm run inspect:http`.
3. In the Inspector, set **Transport** to *Streamable HTTP* and the **URL** to `http://localhost:3000/mcp`.
4. Open **Authentication**, set **Client ID** to your `COGNITO_CLIENT_ID` and **Scope** to `openid`, then click **Connect**. The Inspector should send you to the Cognito login page. Log in, change your password, and set up MFA.
5. Back in the Inspector, **List Tools** should show all ten tools. Try `list_folders`.
6. Check that the lock works: run `curl -i -X POST http://localhost:3000/mcp`. It must answer **401** with a `WWW-Authenticate` header.

If the Cognito page shows an error such as `redirect_mismatch` or `invalid_request`, copy only the error text (not any codes in the address bar) and send it to Claude.

## Troubleshooting

| Error | Likely cause |
|---|---|
| `Missing YAHOO_EMAIL or YAHOO_APP_PASSWORD` | `.env` is missing or a value is empty |
| `AUTHENTICATIONFAILED` / `Invalid credentials` | Wrong app password, or using your normal Yahoo password. Generate a new app password |
| `Mailbox doesn't exist` | Folder name mismatch. Use the exact `path` from `list_folders` |
| `Could not find the Drafts folder` (or Sent, Trash, Archive) | Yahoo uses unusual names on your account. Run `list_folders` and tell Claude the names |
| `Daily send limit reached` | `MAX_SENDS_PER_DAY` sends already today (UTC). Raise it in `.env` if needed |
| `That code is unknown, already used, or expired` | Codes work once and expire after 10 minutes. Run `send_email` or `delete_message` again |
| `getaddrinfo ENOTFOUND` | No internet, or a network that blocks port 993 |

## Security notes

- No credentials are stored in the code or the repo.
- Email contents are written by whoever sent them, and can contain text that tries to instruct an AI. `read_message` labels its output as untrusted data. Sending and deleting always need a preview code first (see Safety design).
- You can revoke the app password at any time in Yahoo Account Security, which cuts off this server immediately.
