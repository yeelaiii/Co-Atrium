# Co-Atrium

> Casting a new light on communication within the built environment.

Construction coordination software for Singapore SMEs. One project, one view — no more juggling seven tools to coordinate one site.

---

##  Live demo

**[https://yeelaiii.github.io/Co-Atrium/](https://yeelaiii.github.io/Co-Atrium/)**

- Landing page explains the product
- Click **Try Demo** → opens the interactive prototype
- Responsive: full desktop layout on laptops, mobile phone frame on smaller screens
- No signup, no install. All data is hardcoded for now.

---

##  What's built (prototype phase)

A fully interactive hi-fi prototype covering:

### Screens
- **Dashboard** — Project completion ring, stats, critical alerts, recent activity, drawing status
- **Tasks** — Grouped by In Progress / Pending / Completed, with priority tags and assignee avatars
- **Drawings** — Grouped by discipline (Architectural / Structural / MEP) with full-screen viewer
- **Messages** — Conversation list with full thread view and live send
- **Settings** — Placeholder

### Modals
- Issue detail sheet (from dashboard alert)
- Drawing viewer with zoom
- Message thread

### Design language
- Off-white eggshell base (`#F5F2EC`) with deep navy text
- Teal accent (`#0d9488`)
- Cormorant Garamond for headings, Space Grotesk for UI
- Glassmorphic cards with subtle shadow lift

---

##  Repo structure

```
Co-Atrium/
├── index.html              # Marketing landing page
├── app.html                # Hi-fi interactive prototype (self-contained, ~1.6MB)
├── README.md
├── .gitignore
├── docs/
│   └── data-model.md       # Data model spec for the future backend build
├── apps/
│   ├── web/                #  React web app (to be built)
│   ├── mobile/             #  React Native mobile app
│   └── api/                #  Node.js backend API
├── packages/
│   ├── ui/                 #  Shared design system
│   ├── types/              #  Shared TypeScript types
│   └── utils/              #  Shared utility functions
└── .github/workflows/      #  CI/CD
```

`index.html` and `app.html` are the **current deliverables**. The `apps/`, `packages/`, and workflow folders are scaffolded for the next phase of work — building the real product from the prototype.

---

## 📋 Roadmap

- [x] Hi-fi mobile prototype (5 screens + overlays)
- [x] Responsive desktop layout
- [x] Marketing landing page
- [x] Data model spec
- [x] Monorepo scaffold
- [ ] User testing with 2–3 real PMs
- [ ] More/Settings screen build-out
- [ ] New Task / Raise Issue / Upload Drawing forms
- [ ] Build out `apps/web` from the prototype
- [ ] Build out `apps/api` from the data model
- [ ] Build out `apps/mobile`

---

##  How to view locally

Either file works standalone — just open in a browser.

```bash
# Clone the repo
git clone https://github.com/yeelaiii/Co-Atrium.git
cd Co-Atrium

# Open the landing page
open index.html        # macOS
xdg-open index.html    # Linux
start index.html       # Windows

# Or open the prototype directly
open app.html
```

No build step, no dependencies, no server needed. The prototype bundles React, fonts, and all assets inline.

---

