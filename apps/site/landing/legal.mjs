// The legal pages' words, in Apollo's structure and tone (apollo: src/components/apollo/marketing/pages/legal-page.tsx),
// with every fact rewritten for qalm and checked against qalm's code. When qalm changes (providers, sign-in, storage,
// retention, AI access), update this file and UPDATED in site.mjs.
//
// Where each fact comes from:
// - Hosting: apps/server/wrangler.jsonc (Workers, D1, R2, Durable Objects, KV; no location hint or jurisdiction set).
// - Email: apps/server/src/email.ts (Resend).
// - Sign-in TTLs: apps/server/src/auth.ts (links and codes 15 min, 5 code tries, access 1 h, sessions 60 days
//   rotating, rate-limit records pruned after 1 h, the approval-page cookie 1 h).
// - Agents: apps/server/src/grants.ts (approval ends 30 days after it is given), mcp.ts (wait, read, transcribe,
//   comment; comment and transcribe each need their own permission), migrations (activity log, ai_access default off).
// - Deletion: docs.ts deleteNotebook (pages purged, a tombstone row kept); account.ts deleteAccount (Settings → Delete
//   account: emailed 6-digit code; rooms purged, unshared R2 objects, OAuth grants and every D1 row for the user deleted;
//   the app then removes the account's docs and token on that device).
// - Storage: apps/server/src/storage.ts (250 MB per account: imported files plus notebook data; at the cap only
//   imports are refused).
// - Device storage: apps/app/src/auth/tokenStore*.ts (keychain/keystore; localStorage on web), sync/persistence.web.ts
//   (IndexedDB), lib/kv.web.ts (localStorage).
// - Analytics: none in the code.
import { legalEntity, privacyEmail, supportEmail, UPDATED } from './site.mjs';

const privacySections = [
  {
    title: 'Who we are',
    body: [
      `qalm (qalm.apollolearn.app and the qalm apps) is part of Apollo and is operated by ${legalEntity.name}, an individual based in ${legalEntity.location}. qalm is not a registered company. In this notice, "qalm", "we" and "us" mean ${legalEntity.name} as the operator of qalm.`,
      `We are the controller of the personal information described here. For privacy questions or requests, email ${privacyEmail}.`,
    ],
  },
  {
    title: 'What qalm collects',
    body: 'We collect what we need to run a handwriting notebook that keeps your pages in sync across your devices.',
    items: [
      'Account information: your email address, your name if you give one, and when you created your account. qalm signs you in with a link or a 6-digit code sent to your email. It has no passwords.',
      'Sign-in records: one session per signed-in device, and short-lived sign-in links and codes. We store these only as one-way hashes, never in a form that could be used to sign in.',
      'Your notebooks: titles, folders, covers and paper, pages, ink, typed text, shapes, the PDFs and images you import, comments, readings (text versions of your handwriting, saved by you or by an agent you allowed), and the pen colours you save.',
      'AI access, if you use it: which notebooks have AI access turned on, the agents you approved and what each may do, connection requests, and a log of what each agent did (the tool it used, the notebook or page, and an estimate of the tokens it used).',
      'Technical and security information: the IP address and email address of each sign-in email request, used for rate limits, and the request logs Cloudflare keeps for our servers (for example the time, address and result of a request).',
    ],
    after: 'We do not ask for your date of birth, phone number, home address, or payment details. qalm has no handwriting recognition of its own: our servers store your ink but do not read it.',
  },
  {
    title: 'How qalm uses data and why',
    body: 'We use personal information only for the purposes below. Where the law of your country requires a legal basis (for example UK or EU data protection law), it is shown in brackets.',
    items: [
      'To create and secure your account, sign you in, and keep your notebooks private to you (to provide the service you asked for).',
      'To store your notebooks, sync them across your devices, show your PDFs and images, and export them when you ask (to provide the service).',
      'To send sign-in emails. qalm sends no marketing email (to provide the service).',
      'To give an AI agent you approved the parts of a notebook you turned AI access on for, as described below (to provide the service you asked for, with your permission, which you can withdraw at any time).',
      'To keep qalm safe: limiting sign-in emails, preventing abuse, and debugging problems (our legitimate interest in a secure, reliable service).',
      'To comply with legal obligations and respond to lawful requests (legal obligation).',
    ],
    after: 'We do not sell personal information, show advertising, or build advertising profiles. qalm has no analytics or tracking tools.',
  },
  {
    title: 'AI, if you choose to use it',
    body: [
      'qalm runs no AI models of its own and sends nothing to AI providers by itself. AI access is off for every notebook until you turn it on.',
      'If you turn on AI access for a notebook and approve an agent (an AI app such as Claude, from your own AI provider and signed in to your own account), that agent can use the Model Context Protocol (MCP) to read that notebook: small cropped images of the ink you add or erase, with the ink around it for context, and the text, comments and readings there. If you allow it, it can also leave comments pinned to your ink and save readings. It can never change, move or erase your ink.',
      'What an agent receives is handled by your AI provider under your own agreement with them, and their terms and privacy policy apply to it. Choose a provider you trust with your notes.',
      'You can pause sharing, turn AI access off for a notebook, or disconnect an agent at any time. An approval also ends 30 days after you give it; to keep using that agent, you approve it again.',
    ],
  },
  {
    title: 'Who we share data with',
    body: 'We share personal information only with service providers that process it on our behalf to run qalm, under terms that limit their use of it:',
    items: [
      'Cloudflare: hosting for the website, the apps’ server and the downloads, and storage for accounts, notebooks, files and agent connections (Workers, D1, R2, Durable Objects and KV).',
      'Resend: sending sign-in emails. It receives your email address and the sign-in link and code.',
      'Google Fonts: this website loads its fonts from Google, so your browser connects to Google when you open it. The apps bundle their own fonts.',
    ],
    after: 'qalm has no sharing between users, so nobody else sees your notebooks. An AI agent you approve is not our service provider: you choose it and direct what it receives, as described above. We may also disclose information if required by law, to protect the safety of a person, or as part of a merger, acquisition, or sale of the business, in which case this notice will continue to apply to your data.',
  },
  {
    title: 'Where your data is stored',
    body: 'qalm runs on Cloudflare’s global network. We have not limited your data to a particular country or region, so Cloudflare may store and process it in data centres in many countries, including the United States and the European Union. Resend, which sends our emails, is based in the United States. Where data protection law requires it, we rely on appropriate safeguards such as the provider’s standard contractual clauses or equivalent terms.',
  },
  {
    title: 'Children and young people',
    body: [
      'You must be at least 13 to create a qalm account. If you are under 18, or under the age of digital consent where you live, please use qalm with the knowledge of a parent or guardian, or through your school.',
      'We collect only what qalm needs to work, keep notebooks private, and do not show advertising or use analytics. If you believe a child under 13 has created an account, email us and we will delete it.',
    ],
  },
  {
    title: 'Cookies and device storage',
    body: 'qalm uses browser and device storage for these purposes:',
    items: [
      'Strictly necessary: your sign-in tokens, kept in the browser’s local storage on the web and in the desktop app, and in the device’s secure keychain or keystore on tablets.',
      'Strictly necessary: when you approve an AI agent in a browser, qalm’s server sets one sign-in cookie on its own address for up to an hour, so the approval page knows it’s you.',
      'Your notebooks on your device: a copy of your notebooks and files (in the browser’s IndexedDB on the web), so qalm opens quickly and works offline.',
      'Preferences: settings such as the theme and your pen and palm options.',
    ],
    after: 'qalm uses no advertising or analytics cookies. Clearing site data or uninstalling the app removes what is stored on that device and signs you out there; anything that has not synced yet is lost.',
  },
  {
    title: 'Retention',
    body: 'We keep personal information only as long as needed for the purposes above:',
    items: [
      'Your account and notebooks: until you delete them, or delete your account (in Settings, or by asking us). Notebooks in the trash stay there until you delete them forever.',
      'A notebook you delete forever: its pages and ink are removed from our servers straight away. We keep a small record of it (its ID, your account, its title and when it was deleted) so the ID cannot be reused. PDFs and images you imported are stored separately and are not removed with the notebook yet; ask us and we will delete them.',
      'Sign-in links and codes: expire after 15 minutes and work once. A code stops working after 5 wrong tries.',
      'Signed-in devices: a device stays signed in for up to 60 days after it last renewed its sign-in. Signing out ends it straight away.',
      'Sign-in email rate-limit records (email and IP address): deleted after an hour.',
      'Agent approvals: end 30 days after you give them, or when you disconnect the agent. The agent activity log is kept with your account so you can review it.',
      'Request logs: kept by Cloudflare for a short period under its own retention settings.',
      'Backups: Cloudflare keeps a short rolling history of our databases for recovery. Deleted data drops out of it as the history rolls over, within about 30 days.',
    ],
    after: 'After an account is deleted we keep nothing about it, except anything we must keep to meet a legal obligation or resolve a dispute, and copies in backups and request logs until they expire.',
  },
  {
    title: 'Security',
    body: 'We use encryption in transit, encryption at rest on Cloudflare, one-way hashes for sign-in tokens, sign-in links tied to the device that asked for them, ownership checks on every notebook and file, and limits on sign-in emails. Notebooks are not end-to-end encrypted: our servers can read them in order to sync them. No online service can be guaranteed completely secure, so please keep access to your email account secure, because it controls sign-in to qalm. If we become aware of a breach affecting your personal information, we will notify you and regulators where the law requires.',
  },
  {
    title: 'Your rights and choices',
    items: [
      'Access, correct, export, or delete your personal information. You can export any notebook yourself as a PDF or a full .qalm backup. See Data Rights for how to ask for the rest.',
      'Object to or restrict processing based on our legitimate interests.',
      'Withdraw your permission for AI access at any time: turn it off for a notebook, or disconnect an agent in Settings.',
      'Complain to a data protection authority. In the UK this is the Information Commissioner’s Office (ico.org.uk); in the EU or EEA it is the authority in your country. We would appreciate the chance to resolve your concern first.',
    ],
  },
  {
    title: 'Changes to this notice',
    body: 'We will update this notice when qalm’s features or providers change. The date at the top shows the latest version. If a change materially affects how we use your personal information, we will tell you in the app or by email before it takes effect.',
  },
];

const termsSections = [
  {
    title: 'About these terms',
    body: [
      `These terms are an agreement between you and ${legalEntity.name} ("qalm", "we", "us"), the individual based in ${legalEntity.location} who operates qalm.apollolearn.app and the qalm apps. By creating an account or using qalm you agree to these terms and to our Privacy Notice.`,
      'If you are using qalm through a school, your school may also have its own rules for how you use it.',
    ],
  },
  {
    title: 'Who can use qalm',
    body: 'You must be at least 13 years old to create a qalm account. If you are under 18, you confirm that a parent or guardian has agreed to you using qalm and to these terms, or that you are using it through your school. You may have only one personal account and must give accurate account details.',
  },
  {
    title: 'Your account',
    body: `qalm signs you in with a link or a 6-digit code sent to your email, so whoever controls your email account can access your qalm account. Keep it secure, do not share sign-in links or codes, and tell us promptly at ${supportEmail} if you think someone else has accessed your account.`,
  },
  {
    title: 'The service and price',
    body: 'qalm is free while it is in beta. Each account has a storage limit, currently 250 MB, which covers the PDFs and images you import and your notebooks. At the limit you can’t import more files, but your handwriting and other edits keep syncing. Some features may be early, change, or be available only on some devices. If we introduce paid features in future, we will explain the price and terms before you are asked to pay, and nothing will be charged without your agreement.',
  },
  {
    title: 'Your content',
    body: 'You keep ownership of your notebooks, handwriting, files, and everything else you add to qalm. You give us a worldwide, non-exclusive, royalty-free licence to host, store, copy, process, transmit, and display that content only as needed to run qalm for you: syncing it, showing it on your devices, exporting it, and giving it to AI agents you approve. This licence ends when your content is deleted, except for copies in backups until they expire.',
  },
  {
    title: 'AI agents you connect',
    body: [
      'Connecting an AI agent is optional. An agent is run by your own AI provider under your own account, not by us, and your provider’s terms apply to it and to what it receives. We do not control what an agent says.',
      'Agent comments and readings can be incomplete or wrong. Check anything important yourself. You are responsible for which notebooks you share with an agent and for following your school’s or exam board’s rules on AI use. An agent can never change, move or erase your ink.',
    ],
  },
  {
    title: 'Acceptable use',
    items: [
      'Only import materials you have the right to use, and do not upload other people’s personal information without their permission.',
      'Do not use qalm to store or share illegal content.',
      'Do not use qalm to cheat in a live exam or assessed coursework, or to break your exam board’s or school’s rules.',
      'Do not attack, overload, scrape, or reverse engineer qalm’s servers, bypass limits or access controls, or access another person’s account or data.',
    ],
    after: `You can report misuse by emailing ${supportEmail}. We may remove content that breaks these terms.`,
  },
  {
    title: 'Apps and downloads',
    body: 'The Windows and Android apps are early builds that are not yet code-signed, so your device may warn you before installing them. Download them only from qalm.apollolearn.app. If we publish qalm in an app store, that store’s terms also apply. Keep your own copies of anything important: you can export any notebook as a PDF or a .qalm backup at any time.',
  },
  {
    title: 'Intellectual property',
    body: [
      'qalm’s software, design, and name belong to us or our licensors. Open-source components are used under their own licences. You may not copy, resell, or redistribute qalm itself.',
      `If you believe material on qalm infringes your rights, email ${privacyEmail} with the material’s location and the basis of your claim, and we will review it promptly.`,
    ],
  },
  {
    title: 'Changes, suspension, and ending your account',
    body: [
      'We may change, add, or remove features and providers, and may suspend qalm for maintenance. We will give reasonable notice of changes that significantly reduce what you can do where we can.',
      'You can stop using qalm and delete your account at any time, in Settings or by asking us. We may suspend or close an account that breaks these terms, creates a security risk, or where the law requires it. Where appropriate we will tell you why and give you a chance to respond.',
    ],
  },
  {
    title: 'Disclaimers and liability',
    body: [
      'qalm is provided as a note-taking tool on an "as is" and "as available" basis. To the extent the law allows, we do not promise that it will be uninterrupted or error-free.',
      'To the extent the law allows, we are not liable for indirect or consequential loss, lost opportunities, or loss of data you could have kept a copy of, and because qalm is free while it is in beta our total liability to you is limited to PKR 10,000. Nothing in these terms limits liability that cannot be limited by law, including for death or personal injury caused by negligence or for fraud, or removes rights you have as a consumer under the law of the country where you live.',
    ],
  },
  {
    title: 'Governing law and disputes',
    body: 'These terms are governed by the laws of Pakistan, and the courts of Pakistan have jurisdiction, but if you live elsewhere you keep the protection of the mandatory consumer laws of your country and may bring a claim in your local courts. Please contact us first so we can try to resolve any problem informally.',
  },
  {
    title: 'Changes to these terms',
    body: 'We may update these terms as qalm changes. We will show the new date at the top and, for significant changes, tell you in the app or by email before they take effect. If you keep using qalm after that, the updated terms apply; if you do not agree, you can stop using qalm and delete your account.',
  },
];

const dataRightsSections = [
  {
    title: 'Requests you can make',
    items: [
      'Access: get a copy of the personal information qalm holds about you.',
      'Correction: fix inaccurate account information.',
      'Export: receive your account records and notebooks in a structured, machine-readable format. You can also export any notebook yourself, at any time, as a PDF or a full .qalm backup.',
      'Deletion: delete your account and everything in it. You can do this yourself in Settings → Delete account.',
      'Objection and restriction: object to processing based on our legitimate interests, or ask us to pause processing while a concern is resolved.',
      'Withdraw permission: turn AI access off for a notebook, or disconnect an agent in Settings, at any time.',
    ],
  },
  {
    title: 'How to make a request',
    body: `Email ${privacyEmail} from the email address you sign in to qalm with, and say which request you are making. To protect your account, we act only on requests we can verify came from the account owner or someone authorised to act for them, and we may ask for more information to confirm this. Making a request is free.`,
  },
  {
    title: 'Parents, guardians, and schools',
    body: 'A parent, guardian, or school can make a request about a young person’s account. We will ask for reasonable proof of authority before releasing, changing, or deleting their data, and may involve them where that is appropriate for their age.',
  },
  {
    title: 'What deletion covers',
    body: `To delete your account, open Settings → Account and sync → Delete account in the app. You type your email, we email you a 6-digit code, and entering it deletes your account for good. You can also email ${privacyEmail} as described above and we will do it for you. Either way, we delete your account and its sign-in sessions on every device, your notebooks with their pages, ink, text, comments and readings, the PDFs and images you imported (if another account imported the very same file, their copy stays for them), your storage records, and your AI access settings, agent approvals and activity log, and we disconnect any agents. Deletion can’t be undone. Deleted data leaves our backups as they roll over.`,
    items: [
      'The device you delete from signs out and removes its copy of the account’s notebooks. Copies on your other devices stay until you sign out there, clear the site’s data, or uninstall the app, because we cannot reach them to erase them.',
      'Deleting a notebook forever in the app removes its pages and ink from our servers straight away; see the Privacy Notice for the small record we keep.',
      'Anything an AI agent already received is held by your AI provider. Ask them to delete it under their own terms.',
    ],
  },
  {
    title: 'Response timing',
    body: 'We aim to respond within one month of receiving a verified request. If a request is complex or we receive many requests, we may take up to two further months and will tell you why. If we cannot fulfil a request, we will explain the reason.',
  },
  {
    title: 'If you are not satisfied',
    body: 'Reply to our response and we will review it again. If you live in the UK you can also complain to the Information Commissioner’s Office (ico.org.uk), and in the EU or EEA to your local data protection authority.',
  },
];

export const legalPages = {
  privacy: {
    path: '/privacy',
    kicker: 'Privacy',
    title: 'Privacy Notice',
    lead: 'Who runs qalm, what we collect, what happens when you connect an AI agent, who we share data with, and how long we keep it.',
    description: 'How qalm handles your account, notebooks and handwriting: what we collect, who we share it with, AI access, and how long we keep it.',
    updated: UPDATED,
    sections: privacySections,
  },
  terms: {
    path: '/terms',
    kicker: 'Terms',
    title: 'Terms of Service',
    lead: 'The agreement for using qalm: who can use it, your content, AI agents you connect, acceptable use, and what happens if something goes wrong.',
    description: 'The terms for using qalm: who can use it, your content, AI agents, acceptable use, liability and governing law.',
    updated: UPDATED,
    sections: termsSections,
  },
  dataRights: {
    path: '/data-rights',
    kicker: 'Data rights',
    title: 'Data Rights',
    lead: 'How to ask for a copy of your qalm data, correct it, export it, or delete your account.',
    description: 'How to access, correct, export or delete your qalm account data.',
    updated: UPDATED,
    sections: dataRightsSections,
  },
};
