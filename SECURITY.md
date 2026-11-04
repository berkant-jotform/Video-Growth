# Security

Keep API keys, passwords, browser tokens and account state outside version control. Use the documented local configuration or credential store; example files must contain empty values or inert placeholders only.

Report suspected vulnerabilities privately to the repository owner through an existing trusted channel. Do not post credentials, private report exports or sensitive logs in issues. If a working secret is exposed, arrange revocation/rotation with its owner; removing a file does not erase Git history.

Source access and application access are separate. Repository visibility does not secure a deployed website or a shared download. Passing tests does not establish live-account authorization or permission to publish content.
