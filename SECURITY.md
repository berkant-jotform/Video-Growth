# Security

Keep API keys, passwords, browser tokens and account state outside version control. Use the documented local configuration or credential store; example files must contain empty values or inert placeholders only.

Report suspected vulnerabilities privately to the repository owner through an existing trusted channel. Do not post credentials, private report exports or sensitive logs in issues. If a working secret is exposed, arrange revocation/rotation with its owner; removing a file does not erase Git history.

Source access and application access are separate. Repository visibility does not secure a deployed website or a shared download. Passing tests does not establish live-account authorization or permission to publish content.

## Reviewer access

When both `SESSION_SECRET` and `APP_SHARED_PASSWORD_HASH` are empty, sign-in stores a self-declared name/initials in an unsigned, HttpOnly, SameSite=Lax cookie (Secure on production HTTPS), valid for 30 days. Anyone who can reach the app can use any reviewer name, edit a cookie, and use the same application permissions. Reviewer labels are attribution hints, not identity proof or an access-control boundary. This mode needs neither a database nor a known signing key.

Setting either variable enables signed cookies and rejects unsigned cookies immediately. A session secret alone does not restrict who may sign in; use the optional shared password to gate access. Mode changes may require signing in again. Logout deletes the current browser cookie; it does not revoke a copied cookie on another device. No session table or business-data migration is involved.
