# HONEST - Frontend

> **"BE HONEST WITH YOURSELF."**  
> *Plan -> Promise -> Do -> Admit -> Reflect -> Start Again*

A student accountability and productivity application built with Vanilla HTML5, CSS3, and JavaScript.

---

## Architecture & Boundary
This folder (`E:\APPP\frontend`) contains **strictly frontend client-side code**:
- No database queries or schemas.
- No Node.js / Express server routes.
- Communicates exclusively through HTTP/REST `fetch()` API calls.
- Pure Vanilla JavaScript without heavy frameworks or build steps.

---

## File Structure
- [index.html](file:///E:/APPP/frontend/index.html) - Accessible single-page layout with views for Today, Calendar, Weekly Report, Archive, Score & Patterns, and Settings. Includes modal flows for Promise Creation, Night Check, Midnight Reflection, and Off-Day Declaration.
- [styles.css](file:///E:/APPP/frontend/styles.css) - Calm, human-designed aesthetic. No purple gradients, no generic AI effects, no pill buttons. Fully responsive across desktop, laptop, tablet, and mobile with Dark and Light themes.
- [api.js](file:///E:/APPP/frontend/api.js) - Centralized API service layer interfacing with backend REST endpoints via `fetch()`. Contains seamless offline preview fallback so the entire interface can be tested immediately even before a backend server is running.
- [app.js](file:///E:/APPP/frontend/app.js) - Application controller managing UI view transitions, client-side UX validations, task completion toggles (`○` / `●`), and modal workflows.
- [API_SPECIFICATION.md](file:///E:/APPP/frontend/API_SPECIFICATION.md) - Exact REST contract for `backend-1`, `backend-2`, and `backend-3` models to implement.

---

## How to Run the Frontend

You can run the frontend using any static web server or open it directly in your browser:

### Option 1: Using Python
```powershell
cd E:\APPP\frontend
python -m http.server 8080
```
Then visit: `http://localhost:8080`

### Option 2: Using Node `npx serve` or `http-server`
```powershell
npx serve E:\APPP\frontend -p 8080
```

### Option 3: Direct Browser Launch
Double-click `E:\APPP\frontend\index.html` in Windows Explorer or open it in your browser.
