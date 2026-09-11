# Worklog App

A lightweight local web app for viewing and managing Jira worklogs across the QA team. Wraps the Jira REST API v3 so you never have to open the Jira worklog dialog.

## What it does

- Week view — browse any week, day by day, with total hours per day and per week
- Switch between team members from a dropdown (pre-seeded from `.env`)
- Create, edit, and delete worklogs through a modal form
- Issue picker with autocomplete — type a key like `PCA-19883` or a keyword to search
- All times displayed and entered in IST

## Requirements

- Node 22+
- A Jira account with API access to `loginradius.atlassian.net`

## Setup

1. Install dependencies:

   ```bash
   npm install
   ```

2. Copy `.env.example` to `.env` and fill in your credentials:

   ```bash
   cp .env.example .env
   ```

   | Variable | Required | Description |
   |----------|----------|-------------|
   | `JIRA_BASE_URL` | Yes | Your Jira instance URL |
   | `JIRA_USER_EMAIL` | Yes | Your Jira account email |
   | `JIRA_API_TOKEN` | Yes | Jira API token (see below) |
   | `PORT` | No | Server port, defaults to `3000` |
   | `TEAM_MEMBERS` | No | JSON array of `{accountId, displayName, emailAddress}` to pre-seed the people picker |

   Generate a Jira API token at: Account Settings → Security → API tokens.

3. Start the server:

   ```bash
   # production
   npm start

   # development (auto-restarts on file changes)
   npm run dev
   ```

4. Open `http://localhost:3000`

## Duration format

The duration field accepts several formats:

| Input | Interpreted as |
|-------|---------------|
| `2h 30m` | 2 hours 30 minutes |
| `2h30m` | 2 hours 30 minutes |
| `1.5h` | 1 hour 30 minutes |
| `90m` | 90 minutes |
| `1:30` | 1 hour 30 minutes |

## API endpoints

The server exposes these endpoints (used by the frontend):

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/config` | Returns team members and Jira base URL |
| GET | `/api/worklogs?accountId=&dates[]=` | Fetch worklogs for a user across given dates |
| POST | `/api/worklogs` | Create a worklog (`issueKey`, `timeSpent`, `started`, `comment`) |
| PUT | `/api/worklogs/:issueKey/:worklogId` | Update a worklog |
| DELETE | `/api/worklogs/:issueKey/:worklogId` | Delete a worklog |
| GET | `/api/issues/search?q=` | Issue autocomplete (key or keyword) |
| GET | `/api/users/search?q=` | Jira user search |

## Security note

The `.env` file contains your Jira API token. Keep it out of version control — add `.env` to `.gitignore` if you push this repo anywhere.
