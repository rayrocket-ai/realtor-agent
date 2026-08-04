import type { FastifyInstance } from "fastify";
import { asc, desc, eq, inArray } from "drizzle-orm";
import { db, pgPool, schema } from "../../db/client.js";
import { config } from "../../config.js";
import { approveOffer, rejectOffer } from "../../offers/approval.js";
import { sendToLead } from "../../channels/outbound.js";
import {
  approvalMode,
  setApprovalMode,
  approvePendingMessage,
  rejectPendingMessage,
} from "../../approvals/messages.js";
import { escapeHtml as esc } from "./approvals.js";
import { labelAnswer } from "../../leads/qualify.js";
import { requireDashboardSession } from "./dashboard-auth.js";
import { activeBuyerProfiles } from "../../buyers/profile.js";
import { recentMatchesByLead } from "../../listings/matcher.js";
import { enqueue } from "../../jobs/queue.js";
import type { BuyerRequirements, PropertyReaction } from "../../db/schema.js";

function layout(title: string, body: string): string {
  const descriptions: Record<string, string> = {
    Today: "The decisions, deadlines, relationships, and system signals that need attention now.",
    Leads: "Every relationship, conversation, and next action in one place.",
    Buyers: "AI-built profiles of every buyer client: requirements, homes seen, reactions, and offers.",
    "Social media leads": "Capture and qualify inbound opportunities from every social channel.",
    Approvals: "Review what Ali plans to send before it reaches a client.",
    Offers: "Prepare, review, and send offer communication with a human checkpoint.",
    Showings: "Track property appointments and their current booking state.",
    Tours: "Coordinate multi-property days, timing, and itineraries.",
    "Listing feedback pipeline": "Turn every showing into structured seller feedback and follow-up.",
    "My Listings": "Manage active inventory and connect BrokerBay feedback workflows.",
    "Agent activity": "A traceable record of what the agent did, used, and produced.",
    "Voice Operations": "Test Ali, review calls, and follow every voice conversation into the CRM.",
    "Learning & notes": "Visible, reversible instructions distilled from your explicit feedback.",
    "Systems & dashboards": "Connection health and specialist consoles across the platform.",
  };
  const description = descriptions[title] ?? "Ray Ahmadi Real Estate operations and intelligence.";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark"><title>${esc(title)} — Ray Central Command</title>
<script>try{document.documentElement.dataset.theme=localStorage.getItem("ray-theme")||"light"}catch(e){}</script>
<style>
  :root{--ink:#101828;--ink-soft:#344054;--muted:#667085;--line:#e4e7ec;--blue:#175cd3;--blue-dark:#1849a9;--violet:#7f56d9;--panel:#fff;--panel-soft:#f8fafc;--page:#f4f6f8;--green:#067647;--green-bg:#ecfdf3;--amber:#b54708;--amber-bg:#fffaeb;--red:#b42318;--red-bg:#fef3f2;--shadow:0 1px 2px rgba(16,24,40,.04),0 8px 24px rgba(16,24,40,.05)}
  :root[data-theme="dark"]{--ink:#f2f4f7;--ink-soft:#e4e7ec;--muted:#98a2b3;--line:#344054;--panel:#182230;--panel-soft:#101828;--page:#0c111d;--blue:#84adff;--blue-dark:#b2ccff;--green:#75e0a7;--green-bg:#073d2a;--amber:#fec84b;--amber-bg:#4e2c0c;--red:#fda29b;--red-bg:#55160c;--shadow:none}
  *{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;background:var(--page);color:var(--ink);font:14px/1.55 Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}a{color:var(--blue)}button,input,textarea,select{font:inherit}
  .app-shell{min-height:100vh;display:grid;grid-template-columns:248px minmax(0,1fr)}
  .sidebar{position:sticky;top:0;height:100vh;overflow-y:auto;padding:22px 14px 18px;background:#101828;color:#d0d5dd;box-shadow:6px 0 24px rgba(16,24,40,.08);z-index:40}
  .brand{display:flex;align-items:center;gap:11px;color:#fff;text-decoration:none;padding:0 9px 23px}.brand-mark{display:grid;place-items:center;width:36px;height:36px;border-radius:11px;background:linear-gradient(145deg,#2e90fa,#7f56d9);font-weight:850;box-shadow:0 8px 22px rgba(46,144,250,.28)}.brand-copy strong{display:block;font-size:14px;letter-spacing:-.01em}.brand-copy span{display:block;color:#98a2b3;font-size:11px;margin-top:1px}
  .nav-group{margin:0 0 19px}.nav-label{padding:0 10px 7px;color:#667085;font-size:10px;font-weight:800;letter-spacing:.11em;text-transform:uppercase}.nav-link{display:flex;align-items:center;gap:10px;margin:2px 0;padding:9px 10px;border-radius:9px;color:#d0d5dd;text-decoration:none;font-weight:620;font-size:13px;transition:background .15s,color .15s,transform .15s}.nav-link:hover{background:#ffffff0d;color:#fff;transform:translateX(1px)}.nav-link.active{background:linear-gradient(90deg,#ffffff18,#ffffff0c);color:#fff;box-shadow:inset 2px 0 #53b1fd}.nav-icon{display:grid;place-items:center;width:20px;height:20px;color:#98a2b3;font-size:15px}.nav-link.active .nav-icon{color:#84adff}.sidebar-foot{margin-top:24px;padding:14px 10px 4px;border-top:1px solid #344054}.sidebar-status{display:flex;align-items:center;gap:8px;color:#d0d5dd;font-size:11px}.status-dot{width:8px;height:8px;border-radius:50%;background:#12b76a;box-shadow:0 0 0 4px #12b76a20}.sidebar-foot small{display:block;color:#667085;margin-top:7px}
  .workspace{min-width:0}.topbar{position:sticky;top:0;z-index:30;height:72px;display:flex;align-items:center;justify-content:space-between;gap:20px;padding:0 34px;background:color-mix(in srgb,var(--page) 88%,transparent);backdrop-filter:blur(16px);border-bottom:1px solid var(--line)}.topbar-left,.topbar-actions{display:flex;align-items:center;gap:10px}.breadcrumb{color:var(--muted);font-size:12px}.breadcrumb strong{color:var(--ink-soft)}.mobile-menu{display:none}.icon-button,.top-action{display:inline-flex;align-items:center;justify-content:center;gap:7px;min-height:38px;border:1px solid var(--line);border-radius:9px;background:var(--panel);color:var(--ink-soft);text-decoration:none;padding:0 11px;font-weight:650;font-size:12px;cursor:pointer;box-shadow:0 1px 2px rgba(16,24,40,.03)}.icon-button{width:38px;padding:0}.top-action:hover,.icon-button:hover{border-color:#98a2b3}.top-action.primary{background:var(--blue);border-color:var(--blue);color:#fff}.top-action.primary:hover{background:var(--blue-dark)}
  .page{max-width:1600px;margin:0 auto;padding:31px 36px 60px}.page-head{display:flex;justify-content:space-between;align-items:flex-start;gap:24px;margin-bottom:24px}.page-head h1{margin:0;color:var(--ink);font-size:30px;line-height:1.15;letter-spacing:-.035em}.page-head p{max-width:720px;margin:7px 0 0;color:var(--muted);font-size:14px}.page-badge{flex:none;display:flex;align-items:center;gap:8px;padding:8px 11px;border:1px solid var(--line);border-radius:999px;background:var(--panel);color:var(--ink-soft);font-size:11px;font-weight:700}.content-inner{min-width:0;overflow-x:auto;padding:1px 1px 18px}
  h2,h3{letter-spacing:-.02em}h2{font-size:23px;margin:28px 0 14px}h3{font-size:17px;margin:27px 0 10px}p{margin:9px 0 14px}
  table{border-collapse:separate;border-spacing:0;width:100%;min-width:680px;font-size:13px;background:var(--panel);border:1px solid var(--line);border-radius:14px;overflow:hidden;box-shadow:0 1px 2px rgba(16,24,40,.025)}th,td{text-align:left;padding:12px 14px;border-bottom:1px solid var(--line);vertical-align:top}th{background:var(--panel-soft);color:var(--muted);font-size:10px;letter-spacing:.075em;text-transform:uppercase;font-weight:800;white-space:nowrap}tr:last-child td{border-bottom:0}tbody tr:hover td{background:color-mix(in srgb,var(--blue) 3%,var(--panel))}
  .pill{display:inline-flex;align-items:center;gap:5px;padding:3px 8px;border-radius:999px;font-size:11px;font-weight:700;background:var(--panel-soft);color:var(--ink-soft);border:1px solid var(--line)}.pill.offer_sent,.pill.approved_sent,.pill.confirmed,.pill.completed,.pill.active,.pill.hot{color:var(--green);background:var(--green-bg);border-color:transparent}.pill.pending_approval,.pill.pending,.pill.warm,.pill.calling,.pill.approved{color:var(--amber);background:var(--amber-bg);border-color:transparent}.pill.rejected,.pill.lost,.pill.paused,.pill.failed,.pill.cancelled,.pill.cold{color:var(--red);background:var(--red-bg);border-color:transparent}
  .msg{padding:11px 13px;border:1px solid var(--line);border-radius:12px;margin:7px 0;max-width:82%;white-space:pre-wrap;font-size:13px}.inbound{background:var(--panel)}.outbound{background:color-mix(in srgb,var(--blue) 9%,var(--panel));margin-left:auto}.internal_note{background:var(--amber-bg);font-style:italic}
  .btn{display:inline-flex;align-items:center;justify-content:center;min-height:38px;padding:7px 14px;border-radius:9px;border:1px solid transparent;font-weight:700;cursor:pointer;font-size:12px;text-decoration:none;transition:transform .12s,filter .12s}.btn:hover{filter:brightness(.96);transform:translateY(-1px)}.approve{background:var(--blue);color:#fff}.reject{background:var(--red);color:#fff}.neutral{background:var(--panel);color:var(--ink-soft);border-color:var(--line)}
  textarea,input[type=text],input[type=email],input[type=tel],select{width:100%;min-height:40px;padding:9px 11px;border:1px solid #d0d5dd;border-radius:9px;background:var(--panel);color:var(--ink);font-size:13px;box-sizing:border-box;outline:none}textarea{min-height:110px;resize:vertical}textarea:focus,input:focus,select:focus{border-color:var(--blue);box-shadow:0 0 0 3px color-mix(in srgb,var(--blue) 17%,transparent)}label{color:var(--ink-soft);font-weight:650}form .btn{margin-top:8px}pre{white-space:pre-wrap;background:var(--panel-soft);border:1px solid var(--line);padding:14px;border-radius:11px;font-size:12px;color:var(--ink-soft)}code{padding:2px 5px;border-radius:5px;background:var(--panel-soft);border:1px solid var(--line)}.muted{color:var(--muted);font-size:12px}form.inline{display:inline}.error{padding:12px 14px;border-radius:10px;background:var(--red-bg);color:var(--red);font-weight:650}.outcome{padding:12px 14px;border-radius:10px;background:var(--green-bg);color:var(--green);font-weight:650}
  .cards,.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:14px;margin:18px 0}.card,.stat{border:1px solid var(--line);border-radius:16px;padding:18px;background:var(--panel);box-shadow:var(--shadow)}.card{transition:transform .15s,box-shadow .15s}.card:hover{transform:translateY(-2px);box-shadow:0 12px 30px rgba(16,24,40,.08)}.card h3{margin:0 0 8px}.card p{margin:6px 0}.status{font-weight:750;color:var(--green)}.stat span{display:block;color:var(--muted);font-size:11px}.stat strong{display:block;margin:4px 0;font-size:25px;letter-spacing:-.035em}.attention-grid{display:grid;grid-template-columns:1fr 1fr;gap:14px}.focus-list{display:grid;gap:9px}.focus-item{display:grid;grid-template-columns:9px 1fr auto;gap:10px;align-items:start;padding:10px;border:1px solid var(--line);border-radius:10px;background:var(--panel-soft)}.focus-dot{width:9px;height:9px;margin-top:4px;border-radius:50%;background:var(--amber)}.focus-dot.ready{background:var(--green)}.focus-copy strong,.focus-copy span{display:block}.focus-copy strong{font-size:12px}.focus-copy span{font-size:10px;color:var(--muted);margin-top:2px}.focus-tag{font-size:9px;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);font-weight:800}.empty-state{padding:24px;text-align:center;color:var(--muted);border:1px dashed var(--line);border-radius:12px;background:var(--panel-soft)}
  .command-hero{position:relative;overflow:hidden;display:grid;grid-template-columns:minmax(0,1.25fr) minmax(260px,.75fr);gap:24px;align-items:end;padding:27px 29px;border-radius:20px;background:linear-gradient(135deg,#101828 0%,#162b52 62%,#312e6f 100%);color:#fff;box-shadow:0 18px 40px rgba(16,24,40,.16)}.command-hero:after{content:"";position:absolute;right:-75px;top:-115px;width:280px;height:280px;border:1px solid #ffffff1f;border-radius:50%;box-shadow:0 0 0 44px #ffffff08,0 0 0 88px #ffffff05}.hero-content,.hero-pulse{position:relative;z-index:1}.hero-kicker{margin:0 0 7px;color:#b2ccff;font-size:11px;font-weight:800;letter-spacing:.12em;text-transform:uppercase}.hero-title{margin:0;font-size:30px;line-height:1.12;letter-spacing:-.04em}.hero-copy{max-width:650px;margin:9px 0 0;color:#d0d5dd}.hero-pulse{justify-self:end;min-width:230px;padding:15px 17px;border:1px solid #ffffff24;border-radius:14px;background:#ffffff0d;backdrop-filter:blur(8px)}.pulse-label{color:#b2ccff;font-size:10px;font-weight:800;letter-spacing:.1em;text-transform:uppercase}.pulse-value{display:flex;align-items:center;gap:9px;margin-top:5px;font-size:16px;font-weight:760}.pulse-value .status-dot{flex:none}.pulse-detail{margin-top:4px;color:#d0d5dd;font-size:11px}.command-metrics{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:14px;margin:16px 0 22px}.metric-card{position:relative;min-width:0;padding:17px 18px;border:1px solid var(--line);border-radius:16px;background:var(--panel);box-shadow:var(--shadow)}.metric-top{display:flex;align-items:center;justify-content:space-between;gap:12px}.metric-label{color:var(--muted);font-size:11px;font-weight:700}.metric-icon{display:grid;place-items:center;width:30px;height:30px;border-radius:9px;background:color-mix(in srgb,var(--blue) 10%,var(--panel));color:var(--blue);font-weight:800}.metric-value{display:block;margin:11px 0 2px;font-size:27px;line-height:1;letter-spacing:-.045em}.metric-foot{color:var(--muted);font-size:10px}.metric-foot.good{color:var(--green)}.metric-foot.attention{color:var(--amber)}.command-grid{display:grid;grid-template-columns:minmax(0,1.15fr) minmax(330px,.85fr);gap:14px;margin-top:14px}.panel{min-width:0;padding:20px;border:1px solid var(--line);border-radius:16px;background:var(--panel);box-shadow:var(--shadow)}.panel-head{display:flex;align-items:flex-start;justify-content:space-between;gap:18px;margin-bottom:16px}.panel-head h2{margin:0;font-size:17px}.panel-head p{margin:3px 0 0;color:var(--muted);font-size:11px}.panel-link{flex:none;font-size:11px;font-weight:750;text-decoration:none}.attention-list{display:grid;gap:9px}.attention-item{display:grid;grid-template-columns:36px 1fr auto;gap:11px;align-items:center;padding:11px;border:1px solid var(--line);border-radius:11px;background:var(--panel-soft);text-decoration:none;color:var(--ink)}.attention-symbol{display:grid;place-items:center;width:36px;height:36px;border-radius:10px;background:var(--amber-bg);color:var(--amber);font-weight:850}.attention-copy strong,.attention-copy span{display:block}.attention-copy strong{font-size:12px}.attention-copy span{margin-top:1px;color:var(--muted);font-size:10px}.attention-count{font-size:17px;font-weight:800;color:var(--ink)}.pipeline-list{display:grid;gap:13px}.pipeline-row{display:grid;grid-template-columns:118px minmax(0,1fr) 34px;gap:10px;align-items:center}.pipeline-name{font-size:11px;font-weight:700;color:var(--ink-soft)}.pipeline-track{height:8px;overflow:hidden;border-radius:999px;background:var(--panel-soft);border:1px solid var(--line)}.pipeline-fill{height:100%;width:var(--progress);border-radius:inherit;background:linear-gradient(90deg,var(--blue),var(--violet))}.pipeline-total{text-align:right;font-size:11px;font-weight:800}.section-row{display:flex;align-items:end;justify-content:space-between;gap:16px;margin:25px 0 11px}.section-row h2{margin:0;font-size:18px}.section-row p{margin:3px 0 0;color:var(--muted);font-size:11px}.lane-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px}.lane-card{padding:15px;border:1px solid var(--line);border-radius:14px;background:var(--panel)}.lane-top{display:flex;align-items:center;justify-content:space-between;gap:10px}.lane-name{font-size:12px;font-weight:800}.lane-state{font-size:9px;font-weight:800;letter-spacing:.05em;text-transform:uppercase;color:var(--muted)}.lane-value{display:block;margin-top:13px;font-size:22px;letter-spacing:-.04em}.lane-note{display:block;color:var(--muted);font-size:10px}.recent-wrap{margin-top:14px}.recent-wrap table{min-width:620px}
  .voice-hero{display:grid;grid-template-columns:minmax(0,1.2fr) minmax(260px,.8fr);gap:14px;margin-bottom:18px}.voice-widget{min-height:150px;display:grid;place-items:center;margin-top:14px;padding:20px;border:1px dashed var(--line);border-radius:12px;background:var(--panel-soft)}
  :focus-visible{outline:3px solid color-mix(in srgb,var(--blue) 34%,transparent);outline-offset:2px}.sidebar-backdrop{display:none}
  @media(max-width:1100px){.command-metrics,.lane-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.command-grid{grid-template-columns:1fr}}
  @media(max-width:980px){.app-shell{grid-template-columns:1fr}.sidebar{position:fixed;left:0;top:0;width:264px;transform:translateX(-105%);transition:transform .2s}.sidebar.open{transform:translateX(0)}.sidebar-backdrop.open{display:block;position:fixed;inset:0;background:#10182880;z-index:35}.mobile-menu{display:inline-flex}.page{padding:26px 22px 50px}.topbar{padding:0 22px}.attention-grid,.voice-hero{grid-template-columns:1fr}.command-hero{grid-template-columns:1fr}.hero-pulse{justify-self:start}}
  @media(max-width:620px){.top-action span{display:none}.page{padding:22px 14px 42px}.topbar{padding:0 14px;height:64px}.page-head{display:block}.page-head h1{font-size:26px}.page-badge{display:inline-flex;margin-top:14px}.cards,.stats,.command-metrics,.lane-grid{grid-template-columns:1fr}.command-hero{padding:23px 20px}.hero-title{font-size:26px}.hero-pulse{min-width:0;width:100%}.msg{max-width:94%}}
  @media(prefers-reduced-motion:reduce){*{scroll-behavior:auto!important;transition:none!important}}
</style></head><body>
<div class="sidebar-backdrop" id="sidebar-backdrop"></div><div class="app-shell">
<aside class="sidebar" id="sidebar"><a class="brand" href="/admin"><span class="brand-mark">R</span><span class="brand-copy"><strong>Central Command</strong><span>Ray Ahmadi Real Estate</span></span></a>
  <nav aria-label="Primary navigation">
    <div class="nav-group"><div class="nav-label">Command</div>
      <a class="nav-link" href="/admin"><span class="nav-icon">◫</span>Today</a><a class="nav-link" href="/admin/approvals"><span class="nav-icon">✓</span>Approvals</a>
    </div>
    <div class="nav-group"><div class="nav-label">Relationships</div>
      <a class="nav-link" href="/admin/leads"><span class="nav-icon">◎</span>Leads</a><a class="nav-link" href="/admin/buyers"><span class="nav-icon">⌂</span>Buyers</a><a class="nav-link" href="/admin/social"><span class="nav-icon">↗</span>Social Media</a>
    </div>
    <div class="nav-group"><div class="nav-label">Transactions</div>
      <a class="nav-link" href="/admin/offers"><span class="nav-icon">◇</span>Offers</a><a class="nav-link" href="/admin/showings"><span class="nav-icon">▣</span>Showings</a><a class="nav-link" href="/admin/tours"><span class="nav-icon">⌘</span>Tours</a><a class="nav-link" href="/admin/feedback"><span class="nav-icon">☆</span>Feedback</a><a class="nav-link" href="/admin/listings"><span class="nav-icon">⌂</span>My Listings</a>
    </div>
    <div class="nav-group"><div class="nav-label">Intelligence</div>
      <a class="nav-link" href="/admin/activity"><span class="nav-icon">≡</span>Activity</a><a class="nav-link" href="/admin/voice"><span class="nav-icon">◉</span>Voice Agent</a><a class="nav-link" href="/admin/learning"><span class="nav-icon">✦</span>Learning</a>
    </div>
    <div class="nav-group"><div class="nav-label">Platform</div><a class="nav-link" href="/admin/systems"><span class="nav-icon">⚙</span>Systems</a></div>
  </nav>
  <div class="sidebar-foot"><div class="sidebar-status"><span class="status-dot"></span>Central Command online</div><small>Toronto · ${esc(config().TZ)}</small></div>
</aside>
<section class="workspace"><header class="topbar"><div class="topbar-left"><button class="icon-button mobile-menu" id="mobile-menu" type="button" aria-label="Open navigation">☰</button><div class="breadcrumb">Operations&nbsp; / &nbsp;<strong>${esc(title)}</strong></div></div><div class="topbar-actions"><button class="icon-button" id="theme-toggle" type="button" aria-label="Toggle theme">◐</button><form method="post" action="/admin/logout"><button class="top-action" type="submit"><span>Sign</span> out</button></form><a class="top-action" href="/ali-dashboard/"><span>Open</span> Ali</a><a class="top-action primary" href="https://homes.rayrealestate.ca/" target="_blank" rel="noreferrer"><span>Property</span> Search ↗</a></div></header>
<main class="page"><div class="page-head"><div><h1>${esc(title)}</h1><p>${esc(description)}</p></div><div class="page-badge"><span class="status-dot"></span>Live workspace</div></div><div class="content-inner">${body}</div></main></section></div>
<script>(()=>{const sidebar=document.getElementById("sidebar"),backdrop=document.getElementById("sidebar-backdrop"),menu=document.getElementById("mobile-menu");const close=()=>{sidebar?.classList.remove("open");backdrop?.classList.remove("open")};menu?.addEventListener("click",()=>{sidebar?.classList.toggle("open");backdrop?.classList.toggle("open")});backdrop?.addEventListener("click",close);document.querySelectorAll(".nav-link").forEach(link=>{const href=link.getAttribute("href")||"";const here=location.pathname;const active=href==="/admin"?here==="/admin"||here==="/admin/":here===href||here.startsWith(href+"/");if(active){link.classList.add("active");link.setAttribute("aria-current","page")}});document.getElementById("theme-toggle")?.addEventListener("click",()=>{const next=document.documentElement.dataset.theme==="dark"?"light":"dark";document.documentElement.dataset.theme=next;try{localStorage.setItem("ray-theme",next)}catch(e){}})})();</script>
</body></html>`;
}

function fmt(d: Date | null): string {
  if (!d) return "";
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: config().TZ,
    dateStyle: "medium",
    timeStyle: "short",
  }).format(d);
}

interface VoiceCallRow {
  id: string;
  direction: string;
  from_number: string | null;
  to_number: string | null;
  contact_name: string | null;
  agent_type: string | null;
  purpose: string;
  status: string;
  consent_basis: string;
  summary: string | null;
  outcome: string | null;
  next_action: string | null;
  error: string | null;
  created_at: Date;
}

interface VoiceTaskRow {
  task_type: string;
  status: string;
  notes: string | null;
  due_at: Date | null;
}

interface VoiceTranscriptRow {
  speaker: string;
  text: string;
  time_in_call_seconds: number | null;
}

interface DashboardSummaryRow {
  active_leads: number;
  new_this_week: number;
  untriaged_leads: number;
  followups_due: number;
  pending_approvals: number;
  upcoming_showings: number;
  active_listings: number;
  queued_jobs: number;
  failed_jobs_24h: number;
}

interface DashboardStageRow {
  stage: string;
  total: number;
}

interface DashboardLeadRow {
  id: string;
  name: string | null;
  email: string | null;
  phone: string | null;
  stage: string;
  updated_at: Date;
}

function stageLabel(stage: string): string {
  return stage.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function dashboardDate(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: config().TZ,
    weekday: "long",
    month: "long",
    day: "numeric",
  }).format(new Date());
}

export async function dashboardRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("onRequest", requireDashboardSession);

  app.get("/", async (_req, reply) => {
    const pool = pgPool();
    const [summaryResult, stageResult, recentResult] = await Promise.all([
      pool.query<DashboardSummaryRow>(`SELECT
        (SELECT count(*)::int FROM leads WHERE paused = false) AS active_leads,
        (SELECT count(*)::int FROM leads WHERE created_at >= now() - interval '7 days') AS new_this_week,
        (SELECT count(*)::int FROM leads WHERE paused = false AND stage = 'new' AND updated_at < now() - interval '48 hours') AS untriaged_leads,
        (SELECT count(*)::int FROM leads WHERE paused = false AND followup_at IS NOT NULL AND followup_at <= now()) AS followups_due,
        ((SELECT count(*)::int FROM pending_messages WHERE status = 'pending') +
         (SELECT count(*)::int FROM offers WHERE status = 'pending_approval'))::int AS pending_approvals,
        (SELECT count(*)::int FROM showings WHERE starts_at >= now() AND status NOT IN ('cancelled', 'completed')) AS upcoming_showings,
        (SELECT count(*)::int FROM listings WHERE status = 'active') AS active_listings,
        (SELECT count(*)::int FROM jobs WHERE status = 'pending') AS queued_jobs,
        (SELECT count(*)::int FROM jobs WHERE status = 'failed' AND created_at >= now() - interval '24 hours') AS failed_jobs_24h`),
      pool.query<DashboardStageRow>(`SELECT stage, count(*)::int AS total
        FROM leads WHERE paused = false GROUP BY stage ORDER BY count(*) DESC, stage ASC`),
      pool.query<DashboardLeadRow>(`SELECT id, name, email, phone, stage, updated_at
        FROM leads WHERE paused = false ORDER BY updated_at DESC LIMIT 6`),
    ]);

    const summary = summaryResult.rows[0] ?? {
      active_leads: 0,
      new_this_week: 0,
      untriaged_leads: 0,
      followups_due: 0,
      pending_approvals: 0,
      upcoming_showings: 0,
      active_listings: 0,
      queued_jobs: 0,
      failed_jobs_24h: 0,
    };
    const attentionItems = [
      summary.pending_approvals > 0
        ? `<a class="attention-item" href="/admin/approvals"><span class="attention-symbol">✓</span><span class="attention-copy"><strong>Decisions waiting</strong><span>Review drafts and approval-gated actions.</span></span><span class="attention-count">${summary.pending_approvals}</span></a>`
        : "",
      summary.followups_due > 0
        ? `<a class="attention-item" href="/admin/leads"><span class="attention-symbol">↗</span><span class="attention-copy"><strong>Follow-ups due</strong><span>Relationships with a due next action.</span></span><span class="attention-count">${summary.followups_due}</span></a>`
        : "",
      summary.untriaged_leads > 0
        ? `<a class="attention-item" href="/admin/leads"><span class="attention-symbol">!</span><span class="attention-copy"><strong>New leads need triage</strong><span>Still new after 48 hours; review ownership and intent.</span></span><span class="attention-count">${summary.untriaged_leads}</span></a>`
        : "",
      summary.failed_jobs_24h > 0
        ? `<a class="attention-item" href="/admin/activity"><span class="attention-symbol">×</span><span class="attention-copy"><strong>Recent automation failures</strong><span>Failed in the last 24 hours and need review.</span></span><span class="attention-count">${summary.failed_jobs_24h}</span></a>`
        : "",
    ].filter(Boolean);
    const maxStageTotal = Math.max(1, ...stageResult.rows.map((row) => row.total));
    const pipelineRows = stageResult.rows.map((row) => {
      const width = Math.max(4, Math.round((row.total / maxStageTotal) * 100));
      return `<div class="pipeline-row"><span class="pipeline-name">${esc(stageLabel(row.stage))}</span><span class="pipeline-track"><span class="pipeline-fill" style="--progress:${width}%"></span></span><span class="pipeline-total">${row.total}</span></div>`;
    }).join("");
    const recentRows = recentResult.rows.map((lead) => `<tr><td><a href="/admin/leads/${lead.id}">${esc(lead.name ?? "Unnamed relationship")}</a></td><td>${esc(lead.email ?? lead.phone ?? "No contact detail")}</td><td><span class="pill ${esc(lead.stage)}">${esc(stageLabel(lead.stage))}</span></td><td>${fmt(lead.updated_at)}</td></tr>`).join("");
    const systemHealthy = summary.failed_jobs_24h === 0;
    const body = `<section class="command-hero"><div class="hero-content"><p class="hero-kicker">${esc(dashboardDate())} · Toronto</p><h2 class="hero-title">Good to see you, Ray.</h2><p class="hero-copy">Central Command turns the business into one reviewable operating picture: who needs attention, what is due, what is waiting for approval, and whether the systems behind it are healthy.</p></div><div class="hero-pulse"><span class="pulse-label">Operations pulse</span><div class="pulse-value"><span class="status-dot"></span>${systemHealthy ? "Systems operating normally" : "Review recent failures"}</div><div class="pulse-detail">${summary.queued_jobs} queued job${summary.queued_jobs === 1 ? "" : "s"} · ${summary.failed_jobs_24h} failure${summary.failed_jobs_24h === 1 ? "" : "s"} in 24h</div></div></section>
      <section class="command-metrics" aria-label="Business snapshot"><div class="metric-card"><div class="metric-top"><span class="metric-label">Active lead records</span><span class="metric-icon">◎</span></div><strong class="metric-value">${summary.active_leads}</strong><span class="metric-foot">${summary.new_this_week} added in the last 7 days</span></div><div class="metric-card"><div class="metric-top"><span class="metric-label">Decisions waiting</span><span class="metric-icon">✓</span></div><strong class="metric-value">${summary.pending_approvals}</strong><span class="metric-foot ${summary.pending_approvals ? "attention" : "good"}">${summary.pending_approvals ? "Human review required" : "Approval queue is clear"}</span></div><div class="metric-card"><div class="metric-top"><span class="metric-label">Upcoming showings</span><span class="metric-icon">▣</span></div><strong class="metric-value">${summary.upcoming_showings}</strong><span class="metric-foot">Confirmed future appointments</span></div><div class="metric-card"><div class="metric-top"><span class="metric-label">Active listings</span><span class="metric-icon">⌂</span></div><strong class="metric-value">${summary.active_listings}</strong><span class="metric-foot">Seller inventory in production</span></div></section>
      <section class="command-grid"><div class="panel"><div class="panel-head"><div><h2>Needs attention</h2><p>Only conditions that merit a decision or next action.</p></div><a class="panel-link" href="/admin/activity">Open activity →</a></div><div class="attention-list">${attentionItems.join("") || '<div class="empty-state">Nothing urgent is waiting. New work will appear here automatically.</div>'}</div></div><div class="panel"><div class="panel-head"><div><h2>Pipeline snapshot</h2><p>Current active lead records by legacy stage.</p></div><a class="panel-link" href="/admin/leads">View leads →</a></div><div class="pipeline-list">${pipelineRows || '<div class="empty-state">No active leads yet.</div>'}</div></div></section>
      <div class="section-row"><div><h2>Operating lanes</h2><p>The four business lines the rebuilt OS will manage as concurrent engagements.</p></div></div><section class="lane-grid"><div class="lane-card"><div class="lane-top"><span class="lane-name">Buyer</span><span class="lane-state">Active foundation</span></div><strong class="lane-value">${summary.active_leads}</strong><span class="lane-note">Current lead records; engagement migration comes in Phase 1.</span></div><div class="lane-card"><div class="lane-top"><span class="lane-name">Seller</span><span class="lane-state">Foundation</span></div><strong class="lane-value">${summary.active_listings}</strong><span class="lane-note">Active listings connected to feedback and reporting.</span></div><div class="lane-card"><div class="lane-top"><span class="lane-name">Pre-con</span><span class="lane-state">Planned</span></div><strong class="lane-value">—</strong><span class="lane-note">First-class project, worksheet, allocation, and deadline pipeline.</span></div><div class="lane-card"><div class="lane-top"><span class="lane-name">Recruiting</span><span class="lane-state">Planned</span></div><strong class="lane-value">—</strong><span class="lane-note">Research, conversations, appointments, and onboarding.</span></div></section>
      <div class="section-row"><div><h2>Recently active relationships</h2><p>The latest people touched by messages, updates, or workflow changes.</p></div><a class="panel-link" href="/admin/leads">View all leads →</a></div><div class="recent-wrap"><table><tr><th>Relationship</th><th>Contact</th><th>Stage</th><th>Last activity</th></tr>${recentRows || '<tr><td colspan="4">No lead activity yet.</td></tr>'}</table></div>`;
    reply.type("text/html");
    return layout("Today", body);
  });

  app.get("/leads", async (_req, reply) => {
    const rows = await db().query.leads.findMany({
      orderBy: desc(schema.leads.updatedAt),
      limit: 100,
    });
    const body = `<table><tr><th>Lead</th><th>Contact</th><th>Stage</th><th>Last activity</th></tr>
      ${rows
        .map(
          (l) => `<tr>
        <td><a href="/admin/leads/${l.id}">${esc(l.name ?? "(no name)")}</a>${l.paused ? ' <span class="pill paused">paused</span>' : ""}</td>
        <td>${esc(l.email ?? "")}<br>${esc(l.phone ?? "")}</td>
        <td><span class="pill ${l.stage}">${esc(l.stage)}</span></td>
        <td>${fmt(l.updatedAt)}</td></tr>`,
        )
        .join("")}
    </table>${rows.length === 0 ? '<p class="muted">No leads yet. They appear automatically when someone emails or messages you.</p>' : ""}`;
    reply.type("text/html");
    return layout("Leads", body);
  });

  app.get("/buyers", async (_req, reply) => {
    const buyers = await activeBuyerProfiles();
    const leadIds = buyers.map((b) => b.lead.id);
    const [openOffers, matchesByLead] = await Promise.all([
      leadIds.length
        ? db().query.offers.findMany({
            where: inArray(schema.offers.leadId, leadIds),
            orderBy: desc(schema.offers.updatedAt),
          })
        : Promise.resolve([]),
      recentMatchesByLead(leadIds),
    ]);
    const offersByLead = new Map<string, typeof openOffers>();
    for (const o of openOffers) {
      if (o.status === "rejected" || o.status === "expired") continue;
      const list = offersByLead.get(o.leadId) ?? [];
      list.push(o);
      offersByLead.set(o.leadId, list);
    }

    const reactionPill = (r: PropertyReaction["reaction"]): string =>
      r === "liked" ? "active" : r === "mixed" ? "pending" : r === "disliked" ? "rejected" : "";
    const reactionLabel = (r: PropertyReaction["reaction"]): string =>
      r === "no_feedback" ? "no feedback" : r;

    const totalHomes = buyers.reduce((n, b) => n + b.profile.propertyReactions.length, 0);
    const totalLiked = buyers.reduce(
      (n, b) => n + b.profile.propertyReactions.filter((r) => r.reaction === "liked").length,
      0,
    );
    const totalOffers = [...offersByLead.values()].reduce((n, list) => n + list.length, 0);

    const cards = buyers
      .map(({ profile, lead }) => {
        const req = (profile.requirements ?? {}) as BuyerRequirements;
        const chips = [
          req.budget ? `Budget: ${req.budget}` : "",
          req.areas?.length ? `Areas: ${req.areas.join(", ")}` : "",
          req.propertyType ? `Type: ${req.propertyType}` : "",
          req.bedrooms ? `Beds: ${req.bedrooms}` : "",
          req.preApproved === true ? "Pre-approved ✓" : req.preApproved === false ? "Not pre-approved" : "",
          req.timeline ? `Timeline: ${req.timeline}` : "",
        ]
          .filter(Boolean)
          .map((chip) => `<span class="pill">${esc(chip)}</span>`)
          .join(" ");
        const homes = profile.propertyReactions
          .map(
            (r) => `<tr><td>${esc(r.address)}${r.mlsNumber ? ` <span class="muted">MLS ${esc(r.mlsNumber)}</span>` : ""}</td>
              <td>${esc(r.shownAt ?? "")}</td>
              <td><span class="pill ${reactionPill(r.reaction)}">${esc(reactionLabel(r.reaction))}</span></td>
              <td class="muted">${esc(r.notes ?? "")}</td></tr>`,
          )
          .join("");
        const leadOffers = (offersByLead.get(lead.id) ?? [])
          .map(
            (o) => `<p><span class="pill ${esc(o.status)}">${esc(o.status.replaceAll("_", " "))}</span>
              <strong>${esc(o.propertyAddress)}</strong>
              ${(o.terms as { price?: number })?.price ? `<span class="muted">$${Number((o.terms as { price?: number }).price).toLocaleString("en-CA")}</span>` : ""}</p>`,
          )
          .join("");
        return `<div class="panel" style="margin:14px 0">
          <div class="panel-head"><div>
            <h2><a href="/admin/leads/${lead.id}">${esc(lead.name ?? lead.email ?? lead.phone ?? "Unnamed buyer")}</a>
              <span class="pill ${esc(lead.stage)}">${esc(stageLabel(lead.stage))}</span>
              ${lead.paused ? '<span class="pill paused">AI paused</span>' : ""}</h2>
            <p>${esc(lead.email ?? "")} ${esc(lead.phone ?? "")}</p>
          </div><span class="muted">Profile updated ${fmt(profile.generatedAt)}</span></div>
          <p>${esc(profile.summary || "No summary yet — refresh profiles to build one.")}</p>
          ${chips ? `<p>${chips}</p>` : ""}
          ${req.mustHaves?.length ? `<p class="muted">Must-haves: ${esc(req.mustHaves.join(", "))}</p>` : ""}
          ${req.dealBreakers?.length ? `<p class="muted">Deal-breakers: ${esc(req.dealBreakers.join(", "))}</p>` : ""}
          ${homes ? `<table><tr><th>Home</th><th>Shown</th><th>Reaction</th><th>Notes</th></tr>${homes}</table>` : '<p class="muted">No homes seen yet.</p>'}
          ${leadOffers ? `<h3>Offers in play</h3>${leadOffers}` : ""}
          ${(matchesByLead.get(lead.id) ?? []).length ? `<p class="muted">Recently matched listings: ${(matchesByLead.get(lead.id) ?? []).map((m) => `${esc(m.address ?? m.mlsNumber ?? "listing")}${m.listPrice ? ` ($${m.listPrice.toLocaleString("en-CA")})` : ""}`).join(" · ")}</p>` : ""}
          ${profile.nextAction ? `<p><strong>Next:</strong> ${esc(profile.nextAction)}</p>` : ""}
        </div>`;
      })
      .join("");

    const body = `<div class="stats">
        <div class="stat"><span>Active buyers</span><strong>${buyers.length}</strong><span>Profiles built by the buyer agent</span></div>
        <div class="stat"><span>Homes in play</span><strong>${totalHomes}</strong><span>${totalLiked} liked</span></div>
        <div class="stat"><span>Offers in play</span><strong>${totalOffers}</strong><span>Pending approval or sent</span></div>
      </div>
      <form class="inline" method="post" action="/admin/buyers/refresh"><button class="btn neutral" type="submit">Refresh profiles now</button></form>
      <span class="muted"> Profiles rebuild automatically every morning at 6:30; the weekly buyer update email goes out Mondays at 8:00.</span>
      ${cards || '<div class="empty-state" style="margin-top:18px">No buyer profiles yet. Hit "Refresh profiles now" — the buyer agent scans every lead with showings, tours, offers, or a buying inquiry and builds profiles for the real buyers.</div>'}`;
    reply.type("text/html");
    return layout("Buyers", body);
  });

  app.post("/buyers/refresh", async (_req, reply) => {
    await enqueue({
      type: "refresh-buyer-profiles",
      payload: { force: false },
      dedupeKey: "refresh-buyer-profiles:manual",
    });
    return reply.redirect("/admin/buyers");
  });

  app.get("/social", async (_req, reply) => {
    const d = db();
    const rows = await d.query.leadSubmissions.findMany({
      orderBy: desc(schema.leadSubmissions.createdAt),
      limit: 100,
    });
    const leadsById = new Map((await d.query.leads.findMany()).map((l) => [l.id, l] as const));
    const shareUrl = `${config().APP_BASE_URL}/connect`;
    const body = `<p class="muted">Share this link on your social media profiles: <strong>${esc(shareUrl)}</strong>
      — add <code>?src=instagram</code> / <code>?src=tiktok</code> to see where each lead came from,
      and <code>?lang=prs</code> to open in Dari by default.</p>
      <table><tr><th>When</th><th>Lead</th><th>Intent</th><th>Score</th><th>Lang</th><th>Answers</th><th>Source</th></tr>
      ${rows
        .map((s) => {
          const lead = leadsById.get(s.leadId);
          const answers = Object.entries(s.answers ?? {})
            .map(([k, v]) => {
              const { label, value } = labelAnswer(k, v);
              return `${esc(label)}: ${esc(value.length > 80 ? `${value.slice(0, 80)}…` : value)}`;
            })
            .join("<br>");
          return `<tr>
            <td>${fmt(s.createdAt)}</td>
            <td><a href="/admin/leads/${s.leadId}">${esc(lead?.name ?? lead?.email ?? lead?.phone ?? "lead")}</a><br>
              <span class="muted">${esc(lead?.phone ?? "")} ${esc(lead?.email ?? "")}</span></td>
            <td><span class="pill">${esc(s.intent)}</span></td>
            <td><span class="pill ${s.score}">${esc(s.score)}</span></td>
            <td>${s.language === "prs" ? "دری" : "EN"}</td>
            <td class="muted">${answers || "—"}</td>
            <td class="muted">${esc(s.source ?? "")}</td></tr>`;
        })
        .join("")}
      </table>${rows.length === 0 ? '<p class="muted">No form submissions yet. Put the link above in your Instagram/TikTok bio to start collecting leads.</p>' : ""}`;
    reply.type("text/html");
    return layout("Social media leads", body);
  });

  app.get<{ Params: { id: string } }>("/leads/:id", async (req, reply) => {
    const d = db();
    const lead = await d.query.leads.findFirst({ where: eq(schema.leads.id, req.params.id) });
    reply.type("text/html");
    if (!lead) return layout("Not found", "<p>Lead not found.</p>");

    const msgs = await d.query.messages.findMany({
      where: eq(schema.messages.leadId, lead.id),
      orderBy: desc(schema.messages.createdAt),
      limit: 100,
    });

    const timeline = msgs
      .reverse()
      .map(
        (m) =>
          `<div class="msg ${m.direction}"><span class="muted">[${esc(m.channel)}] ${fmt(m.createdAt)}</span><br>${esc(m.body)}</div>`,
      )
      .join("");

    const body = `
      <p>${esc(lead.email ?? "")} ${esc(lead.phone ?? "")} — <span class="pill ${lead.stage}">${esc(lead.stage)}</span></p>
      <p class="muted">Preferences: ${esc(JSON.stringify(lead.preferences ?? {}))}</p>
      ${lead.notes ? `<p class="muted">Notes: ${esc(lead.notes)}</p>` : ""}
      <form class="inline" method="post" action="/admin/leads/${lead.id}/pause">
        <button class="btn ${lead.paused ? "approve" : "reject"}" type="submit">
          ${lead.paused ? "Resume AI replies" : "Pause AI (take over)"}
        </button>
      </form>
      <h3>Timeline</h3>
      <div style="display:flex;flex-direction:column">${timeline || '<p class="muted">No messages.</p>'}</div>
      <h3>Send a manual message</h3>
      <p class="muted">Sends from your accounts on the lead's most recent channel, and pauses the AI on this lead for 4 hours.</p>
      <form method="post" action="/admin/leads/${lead.id}/send">
        <textarea name="text" required placeholder="Type your message…"></textarea>
        <button class="btn approve" type="submit">Send</button>
      </form>`;
    return layout(lead.name ?? lead.email ?? "Lead", body);
  });

  app.post<{ Params: { id: string } }>("/leads/:id/pause", async (req, reply) => {
    const d = db();
    const lead = await d.query.leads.findFirst({ where: eq(schema.leads.id, req.params.id) });
    if (lead) {
      await d
        .update(schema.leads)
        .set({ paused: !lead.paused, pausedUntil: null, updatedAt: new Date() })
        .where(eq(schema.leads.id, lead.id));
    }
    return reply.redirect(`/admin/leads/${req.params.id}`);
  });

  app.post<{ Params: { id: string }; Body: { text?: string } }>(
    "/leads/:id/send",
    async (req, reply) => {
      const d = db();
      const lead = await d.query.leads.findFirst({ where: eq(schema.leads.id, req.params.id) });
      const text = (req.body?.text ?? "").trim();
      if (lead && text) {
        await sendToLead(lead, text);
        await d
          .update(schema.leads)
          .set({ pausedUntil: new Date(Date.now() + 4 * 3600_000), updatedAt: new Date() })
          .where(eq(schema.leads.id, lead.id));
      }
      return reply.redirect(`/admin/leads/${req.params.id}`);
    },
  );

  app.get("/offers", async (_req, reply) => {
    const rows = await db().query.offers.findMany({
      orderBy: desc(schema.offers.updatedAt),
      limit: 50,
    });
    const body = rows
      .map((o) => {
        const editForm =
          o.status === "pending_approval"
            ? `<form method="post" action="/admin/offers/${o.id}/approve">
                 <p><label>Recipient (listing agent email):<br><input type="email" name="recipientEmail" value="${esc(o.recipientEmail ?? "")}" required></label></p>
                 <p><label>Subject:<br><input type="text" name="subject" value="${esc(o.draftEmailSubject)}"></label></p>
                 <p><label>Email body:<br><textarea name="body" rows="10">${esc(o.draftEmailBody)}</textarea></label></p>
                 <button class="btn approve" type="submit">Approve &amp; send</button>
               </form>
               <form method="post" action="/admin/offers/${o.id}/reject">
                 <p><label>Or reject with feedback:<br><input type="text" name="feedback" placeholder="What should change?"></label></p>
                 <button class="btn reject" type="submit">Reject draft</button>
               </form>`
            : "";
        return `<div style="border:1px solid #e5e7eb;border-radius:8px;padding:16px;margin:16px 0">
          <p><strong>${esc(o.propertyAddress)}</strong> <span class="pill ${o.status}">${esc(o.status)}</span>
             <span class="muted">${fmt(o.createdAt)}</span></p>
          <pre>${esc(o.summaryMd)}</pre>
          ${o.rejectionFeedback ? `<p class="muted">Rejection feedback: ${esc(o.rejectionFeedback)}</p>` : ""}
          ${editForm}
        </div>`;
      })
      .join("");
    reply.type("text/html");
    return layout("Offers", body || '<p class="muted">No offers yet.</p>');
  });

  app.post<{ Params: { id: string }; Body: { recipientEmail?: string; subject?: string; body?: string } }>(
    "/offers/:id/approve",
    async (req, reply) => {
      const res = await approveOffer(req.params.id, "dashboard", {
        recipientEmail: req.body?.recipientEmail?.trim(),
        subject: req.body?.subject,
        body: req.body?.body,
      });
      if (!res.ok) {
        reply.type("text/html");
        return layout("Approve failed", `<p>⚠️ ${esc(res.error ?? "Unknown error")}</p><p><a href="/admin/offers">Back</a></p>`);
      }
      return reply.redirect("/admin/offers");
    },
  );

  app.post<{ Params: { id: string }; Body: { feedback?: string } }>(
    "/offers/:id/reject",
    async (req, reply) => {
      await rejectOffer(req.params.id, "dashboard", req.body?.feedback ?? "");
      return reply.redirect("/admin/offers");
    },
  );

  app.get("/approvals", async (_req, reply) => {
    const d = db();
    const [pending, mode, recentDecided] = await Promise.all([
      d.query.pendingMessages.findMany({
        where: eq(schema.pendingMessages.status, "pending"),
        orderBy: asc(schema.pendingMessages.createdAt),
      }),
      approvalMode(),
      d.query.pendingMessages.findMany({
        where: eq(schema.pendingMessages.status, "approved"),
        orderBy: desc(schema.pendingMessages.decidedAt),
        limit: 20,
      }),
    ]);
    const cleanApprovals = recentDecided.filter((p) => p.sentText === p.draftText).length;

    const leadsById = new Map(
      (await d.query.leads.findMany()).map((l) => [l.id, l] as const),
    );

    const cards = pending
      .map((p) => {
        const lead = leadsById.get(p.leadId);
        return `<div style="border:1px solid #e5e7eb;border-radius:8px;padding:16px;margin:12px 0">
          <p><strong><a href="/admin/leads/${p.leadId}">${esc(lead?.name ?? lead?.email ?? "lead")}</a></strong>
             <span class="pill">${esc(p.channel)}</span> <span class="muted">${fmt(p.createdAt)}</span></p>
          <form method="post" action="/admin/approvals/${p.id}/approve">
            <textarea name="edited" rows="5">${esc(p.draftText)}</textarea>
            <button class="btn approve" type="submit">Send${"" /* edits auto-detected */}</button>
          </form>
          <form method="post" action="/admin/approvals/${p.id}/reject" class="inline">
            <input type="text" name="reason" placeholder="Reject with feedback…">
            <button class="btn reject" type="submit">Discard</button>
          </form>
        </div>`;
      })
      .join("");

    reply.type("text/html");
    return layout(
      "Approvals",
      `<p>Training wheels: <strong>${mode === "all" ? "ON — every reply needs your approval" : "OFF — replies send automatically"}</strong>
       <form class="inline" method="post" action="/admin/approvals/mode">
         <input type="hidden" name="mode" value="${mode === "all" ? "off" : "all"}">
         <button class="btn neutral" type="submit">${mode === "all" ? "Turn OFF (go full-auto)" : "Turn ON"}</button>
       </form></p>
       <p class="muted">Recent drafts sent without edits: ${cleanApprovals}/${recentDecided.length || 0} — when this is consistently high, it's safe to go full-auto.</p>
       ${cards || '<p class="muted">Nothing waiting for you. 🎉</p>'}`,
    );
  });

  app.post<{ Body: { mode?: string } }>("/approvals/mode", async (req, reply) => {
    const mode = req.body?.mode === "off" ? "off" : "all";
    await setApprovalMode(mode);
    return reply.redirect("/admin/approvals");
  });

  app.post<{ Params: { id: string }; Body: { edited?: string } }>(
    "/approvals/:id/approve",
    async (req, reply) => {
      const pm = await db().query.pendingMessages.findFirst({
        where: eq(schema.pendingMessages.id, req.params.id),
      });
      if (pm) {
        const edited = (req.body?.edited ?? "").trim();
        await approvePendingMessage(
          pm.id,
          "dashboard",
          edited && edited !== pm.draftText ? edited : undefined,
        );
      }
      return reply.redirect("/admin/approvals");
    },
  );

  app.post<{ Params: { id: string }; Body: { reason?: string } }>(
    "/approvals/:id/reject",
    async (req, reply) => {
      await rejectPendingMessage(req.params.id, "dashboard", req.body?.reason ?? "");
      return reply.redirect("/admin/approvals");
    },
  );

  app.get("/tours", async (_req, reply) => {
    const rows = await db().query.tours.findMany({ orderBy: desc(schema.tours.createdAt), limit: 30 });
    const body = rows
      .map(
        (t) => `<div style="border:1px solid #e5e7eb;border-radius:8px;padding:16px;margin:12px 0">
        <p><strong>${esc(t.tourDate)}</strong> <span class="pill ${t.status}">${esc(t.status)}</span>
           <a href="/admin/leads/${t.leadId}" class="muted">lead</a></p>
        <pre>${esc(t.itineraryMd ?? "(itinerary not generated yet — agent calls finalize_tour once all stops are booked)")}</pre>
      </div>`,
      )
      .join("");
    reply.type("text/html");
    return layout("Tours", body || '<p class="muted">No tours yet.</p>');
  });

  app.get("/feedback", async (_req, reply) => {
    const d = db();
    const rows = await d.query.listingShowings.findMany({
      orderBy: desc(schema.listingShowings.updatedAt),
      limit: 100,
    });
    const listingsById = new Map((await d.query.listings.findMany()).map((l) => [l.id, l] as const));
    const body = `<table><tr><th>Listing</th><th>Showing agent</th><th>Buyer interest</th><th>Next follow-up</th><th>Notes</th></tr>
      ${rows
        .map(
          (r) => `<tr>
        <td>${esc(listingsById.get(r.listingId)?.propertyAddress ?? "?")}</td>
        <td>${r.agentLeadId ? `<a href="/admin/leads/${r.agentLeadId}">` : ""}${esc(r.agentName ?? r.agentEmail ?? "?")}${r.agentLeadId ? "</a>" : ""}</td>
        <td><span class="pill">${esc(r.buyerInterest ?? "awaiting")}</span> ${r.followupStatus === "closed" ? '<span class="muted">closed</span>' : ""}</td>
        <td>${fmt(r.nextFollowupAt)}</td>
        <td class="muted">${esc((r.feedbackNotes ?? "").slice(0, 120))}</td></tr>`,
        )
        .join("")}
    </table>${rows.length === 0 ? '<p class="muted">No listing showings yet — they appear automatically from BrokerBay confirmation emails.</p>' : ""}`;
    reply.type("text/html");
    return layout("Listing feedback pipeline", body);
  });

  app.get("/listings", async (_req, reply) => {
    const rows = await db().query.listings.findMany({ orderBy: desc(schema.listings.createdAt) });
    const body = `<form method="post" action="/admin/listings">
        <p><input type="text" name="address" placeholder="Property address (as it appears in BrokerBay emails)" required>
        <input type="text" name="mls" placeholder="MLS # (optional)">
        <button class="btn approve" type="submit">Add listing</button></p>
      </form>
      <table><tr><th>Address</th><th>MLS</th><th>Status</th><th></th></tr>
      ${rows
        .map(
          (l) => `<tr><td>${esc(l.propertyAddress)}</td><td>${esc(l.mlsNumber ?? "")}</td>
          <td><span class="pill ${l.status}">${esc(l.status)}</span></td>
          <td><form class="inline" method="post" action="/admin/listings/${l.id}/toggle"><button class="btn neutral" type="submit">${l.status === "active" ? "Mark sold/inactive" : "Reactivate"}</button></form></td></tr>`,
        )
        .join("")}
      </table>
      <p class="muted">Add your active listings here so BrokerBay showing confirmations on them trigger the feedback follow-up engine.</p>`;
    reply.type("text/html");
    return layout("My Listings", body);
  });

  app.post<{ Body: { address?: string; mls?: string } }>("/listings", async (req, reply) => {
    const address = (req.body?.address ?? "").trim();
    if (address) {
      await db().insert(schema.listings).values({
        propertyAddress: address,
        mlsNumber: (req.body?.mls ?? "").trim() || null,
      });
    }
    return reply.redirect("/admin/listings");
  });

  app.post<{ Params: { id: string } }>("/listings/:id/toggle", async (req, reply) => {
    const l = await db().query.listings.findFirst({ where: eq(schema.listings.id, req.params.id) });
    if (l) {
      await db()
        .update(schema.listings)
        .set({ status: l.status === "active" ? "sold" : "active" })
        .where(eq(schema.listings.id, l.id));
    }
    return reply.redirect("/admin/listings");
  });

  app.get("/activity", async (_req, reply) => {
    const runs = await db().query.agentRuns.findMany({
      orderBy: desc(schema.agentRuns.createdAt),
      limit: 50,
    });
    const body = `<table><tr><th>When</th><th>Trigger</th><th>Tools used</th><th>Outcome</th></tr>
      ${runs
        .map((r) => {
          const tools = (r.toolCalls as Array<{ name?: string }>).map((t) => t.name).filter(Boolean).join(", ");
          return `<tr><td>${fmt(r.createdAt)}</td>
          <td>${r.leadId ? `<a href="/admin/leads/${r.leadId}">${esc(r.trigger)}</a>` : esc(r.trigger)}</td>
          <td class="muted">${esc(tools || "—")}</td>
          <td>${r.error ? `<span class="pill rejected">error</span> <span class="muted">${esc(r.error.slice(0, 80))}</span>` : esc((r.output ?? "").slice(0, 120))}</td></tr>`;
        })
        .join("")}
    </table>`;
    reply.type("text/html");
    return layout("Agent activity", body);
  });

  app.get<{ Querystring: { call?: string } }>("/voice", async (req, reply) => {
    const pool = pgPool();
    const [callsResult, tasksResult] = await Promise.all([
      pool.query<VoiceCallRow>(`SELECT id, direction, from_number, to_number, contact_name, agent_type, purpose, status,
        consent_basis, summary, outcome, next_action, error, created_at
        FROM voice_calls ORDER BY created_at DESC LIMIT 50`),
      pool.query<VoiceTaskRow>(`SELECT task_type, status, notes, due_at
        FROM voice_followup_tasks ORDER BY created_at DESC LIMIT 30`),
    ]);
    const calls = callsResult.rows;
    const tasks = tasksResult.rows;
    const selected = req.query.call ? calls.find((call) => call.id === req.query.call) : calls[0];
    const transcript = selected
      ? (await pool.query<VoiceTranscriptRow>(`SELECT speaker, text, time_in_call_seconds
          FROM voice_transcript_segments WHERE call_id = $1 ORDER BY sequence ASC`, [selected.id])).rows
      : [];
    const c = config();
    const readiness = [
      ["ElevenLabs API", Boolean(c.ELEVENLABS_API_KEY), "Conversation and call runtime"],
      ["Ali voice agent", Boolean(c.ELEVENLABS_AGENT_ID), "Inbound receptionist and browser test"],
      ["Business phone", Boolean(c.ELEVENLABS_PHONE_NUMBER_ID), "Twilio number connected in ElevenLabs"],
      ["Signed webhook", Boolean(c.ELEVENLABS_WEBHOOK_SECRET), "Lead capture and MLS tools protected"],
      ["GoHighLevel", c.highLevelEnabled, "CRM context and message continuity"],
      ["PropTx / VOW", c.mlsEnabled, "Live property facts for approved searches"],
      ["Outbound calling", c.voiceEnabled, "Operator-authorized call switch"],
    ] as const;
    const readyCount = readiness.filter(([, ready]) => ready).length;
    const completed = calls.filter((call) => call.status === "completed").length;
    const failed = calls.filter((call) => call.status === "failed").length;
    const pendingTasks = tasks.filter((task) => task.status === "pending").length;
    const callRows = calls.map((call) => `<tr><td>${fmt(call.created_at)}</td><td>${esc((call.agent_type || "front_desk").replaceAll("_", " "))}</td><td>${esc(call.contact_name || call.from_number || call.to_number || "Unknown")}</td><td>${esc(call.purpose)}</td><td><span class="pill ${esc(call.status)}">${esc(call.status)}</span></td><td>${esc(call.outcome || "—")}</td><td><a href="/admin/voice?call=${encodeURIComponent(call.id)}">Open</a></td></tr>`).join("");
    const taskRows = tasks.map((task) => `<tr><td>${esc(task.task_type.replaceAll("_", " "))}</td><td>${esc(task.notes || "—")}</td><td><span class="pill ${esc(task.status)}">${esc(task.status)}</span></td><td>${fmt(task.due_at)}</td></tr>`).join("");
    const transcriptHtml = transcript.map((segment) => `<div class="msg ${segment.speaker === "agent" ? "outbound" : "inbound"}"><strong>${esc(segment.speaker === "agent" ? "Ali" : "Caller")}</strong>${segment.time_in_call_seconds === null ? "" : ` · ${segment.time_in_call_seconds}s`}<br>${esc(segment.text)}</div>`).join("");
    const body = `<div class="stats"><div class="stat"><span>Connections ready</span><strong>${readyCount}/${readiness.length}</strong><span>${c.voiceEnabled ? "Live calling configured" : "Inbound and test mode"}</span></div><div class="stat"><span>Recent completed calls</span><strong>${completed}</strong><span>In the latest ${calls.length} records</span></div><div class="stat"><span>Pending follow-ups</span><strong>${pendingTasks}</strong><span>Created from voice outcomes</span></div><div class="stat"><span>Failed calls</span><strong>${failed}</strong><span>Available for review</span></div></div>
      <div class="voice-hero"><section class="card"><h3>Talk to Ali</h3><p class="muted">Use the same assistant configured for Ray's office phone. This private browser session is the fastest way to test the greeting, scripts, Dari/English switching, CRM capture, and live property lookup.</p>${c.ELEVENLABS_AGENT_ID ? `<div class="outcome">Ali is ready. Use <strong>Start a call</strong> in the lower-right corner.</div><elevenlabs-convai agent-id="${esc(c.ELEVENLABS_AGENT_ID)}"></elevenlabs-convai>` : '<div class="empty-state">The ElevenLabs agent ID still needs to be configured.</div>'}<p class="muted">Microphone permission is required. Never provide lockbox codes, banking details, or client-confidential information in a test call.</p></section>
      <section class="card"><h3>Connected workflow</h3><div class="focus-list"><div class="focus-item"><span class="focus-dot ready"></span><div class="focus-copy"><strong>Answer and qualify</strong><span>Ali confirms caller identity, intent, urgency, and callback details.</span></div><span class="focus-tag">Voice</span></div><div class="focus-item"><span class="focus-dot ready"></span><div class="focus-copy"><strong>Save to the lead timeline</strong><span>The signed ElevenLabs tool writes the conversation into this CRM.</span></div><span class="focus-tag">CRM</span></div><div class="focus-item"><span class="focus-dot ${c.mlsEnabled ? "ready" : ""}"></span><div class="focus-copy"><strong>Live property facts</strong><span>Address lookups use the licensed PropTx connection and safe field policy.</span></div><span class="focus-tag">MLS</span></div><div class="focus-item"><span class="focus-dot ready"></span><div class="focus-copy"><strong>Create the next action</strong><span>Urgent calls alert Ray; ordinary calls remain in the follow-up queue.</span></div><span class="focus-tag">Follow-up</span></div></div></section></div>
      <section class="card"><h3>Connection checklist</h3><div class="cards">${readiness.map(([name, ready, note]) => `<div class="focus-item"><span class="focus-dot ${ready ? "ready" : ""}"></span><div class="focus-copy"><strong>${esc(name)}</strong><span>${esc(note)}</span></div><span class="focus-tag">${ready ? "Ready" : "Setup"}</span></div>`).join("")}</div><p class="muted">Inbound lead tool: <code>/webhooks/elevenlabs/capture-lead</code> · Property tool: <code>/webhooks/elevenlabs/mls-address</code></p></section>
      <h2>Call history</h2><table><tr><th>Created</th><th>Agent</th><th>Contact</th><th>Purpose</th><th>Status</th><th>Outcome</th><th></th></tr>${callRows || '<tr><td colspan="7">No calls have been recorded yet.</td></tr>'}</table>
      ${selected ? `<div class="attention-grid" style="margin-top:18px"><section class="card"><h3>${esc(selected.contact_name || selected.from_number || selected.to_number || "Voice call")}</h3><p class="muted">${esc(selected.direction)} · ${esc(selected.status)} · ${fmt(selected.created_at)}</p><p><strong>Purpose</strong><br>${esc(selected.purpose)}</p><p><strong>Consent basis</strong><br>${esc(selected.consent_basis)}</p><p><strong>Summary</strong><br>${esc(selected.summary || "Not available yet")}</p><p><strong>Next action</strong><br>${esc(selected.next_action || "Review after the call")}</p>${selected.error ? `<div class="error">${esc(selected.error)}</div>` : ""}</section><section class="card"><h3>Transcript</h3>${transcriptHtml || '<div class="empty-state">The verified post-call transcript will appear here.</div>'}</section></div>` : ""}
      <h2>Follow-up queue</h2><table><tr><th>Task</th><th>Notes</th><th>Status</th><th>Due</th></tr>${taskRows || '<tr><td colspan="4">No voice follow-ups are waiting.</td></tr>'}</table>
      <script src="https://unpkg.com/@elevenlabs/convai-widget-embed" async type="text/javascript"></script>`;
    reply.type("text/html");
    return layout("Voice Operations", body);
  });

  app.get("/systems", async (_req, reply) => {
    const c = config();
    const [leads, lessons, pendingFeedback] = await Promise.all([
      db().query.leads.findMany({ limit: 1 }),
      db().query.lessons.findMany({ where: eq(schema.lessons.active, true) }),
      db().query.agentFeedback.findMany({ where: eq(schema.agentFeedback.distilled, false) }),
    ]);
    const body = `<p>This is the front door for every active control surface. Operational consoles stay separate, but their ownership and purpose are explicit.</p>
      <div class="cards">
        <div class="card"><h3>Central Command</h3><p>Leads, approvals, offers, showings, jobs, voice and GHL.</p><p class="status">Online</p><a class="btn neutral" href="/admin">Open</a></div>
        <div class="card"><h3>Ali</h3><p>Omnichannel lead memory, review queue, briefings and conversations.</p><p class="status">Connected</p><a class="btn neutral" href="/ali-dashboard/">Open</a></div>
        <div class="card"><h3>Campaign Dashboard</h3><p>Marketing campaigns, creative output and publishing operations.</p><p class="status">Connected</p><a class="btn neutral" href="https://campaign.87.99.139.222.sslip.io/">Open</a></div>
        <div class="card"><h3>VOW Property Search</h3><p>Authenticated consumer MLS search backed by PropTx. This is a customer portal, not an operations dashboard.</p><p class="status">Connected</p><a class="btn neutral" href="https://homes.rayrealestate.ca/" target="_blank" rel="noreferrer">Open</a></div>
        <div class="card"><h3>Portainer</h3><p>Infrastructure-only container console. Use for deployment and logs.</p><p class="status">Admin</p><a class="btn neutral" href="https://87.99.139.222:9443/">Open</a></div>
      </div>
      <h3>Channel connections</h3>
      <table><tr><th>Channel</th><th>Connection</th><th>What Ali can do</th></tr>
      <tr><td>Google / Gmail</td><td><span class="pill ${c.gmailEnabled ? "active" : "pending"}">${c.gmailEnabled ? "Connected" : "Setup"}</span></td><td>Read assigned email, reply, and keep the lead timeline synchronized.</td></tr>
      <tr><td>WhatsApp + Instagram</td><td><span class="pill ${c.boosendEnabled ? "active" : "pending"}">${c.boosendEnabled ? "Connected" : "Setup"}</span></td><td>Receive and reply through the Boosend omnichannel connection.</td></tr>
      <tr><td>Telegram</td><td><span class="pill ${c.telegramEnabled ? "active" : "pending"}">${c.telegramEnabled ? "Connected" : "Setup"}</span></td><td>Lead conversations and authorized operations commands.</td></tr>
      <tr><td>GoHighLevel + SMS</td><td><span class="pill ${c.highLevelEnabled ? "active" : "pending"}">${c.highLevelEnabled ? "Configured" : "Setup"}</span></td><td>CRM context is available to Ali and voice; SMS remains governed by the GHL workflow.</td></tr>
      <tr><td>Facebook Messenger</td><td><span class="pill pending">Not connected</span></td><td>Requires a supported inbox/webhook connection before Ali can send or receive.</td></tr>
      <tr><td>Voice / phone</td><td><span class="pill ${c.ELEVENLABS_AGENT_ID && c.ELEVENLABS_WEBHOOK_SECRET ? "active" : "pending"}">${c.ELEVENLABS_AGENT_ID && c.ELEVENLABS_WEBHOOK_SECRET ? "Connected" : "Setup"}</span></td><td>Answer, qualify, capture the lead, perform safe MLS lookups, and create follow-up.</td></tr>
      <tr><td>PropTx MLS + VOW</td><td><span class="pill ${c.mlsEnabled ? "active" : "pending"}">${c.mlsEnabled ? "Connected" : "Setup"}</span></td><td>Live licensed property search with an authenticated consumer portal.</td></tr></table>
      <h3>Shared intelligence</h3>
      <table><tr><th>Area</th><th>Status</th></tr>
      <tr><td>Production database</td><td>${leads.length ? "Connected" : "Ready"}</td></tr>
      <tr><td>Active standing lessons</td><td>${lessons.length}</td></tr>
      <tr><td>Edits waiting for nightly distillation</td><td>${pendingFeedback.length}</td></tr>
      <tr><td>Nightly learning schedule</td><td>03:00 ${esc(c.TZ)}</td></tr></table>
      <p class="muted">The inactive legacy realtor-agent dashboard container is intentionally excluded because it duplicates Central Command and has no public route.</p>`;
    reply.type("text/html");
    return layout("Systems & dashboards", body);
  });

  app.get("/learning", async (_req, reply) => {
    const lessons = await db().query.lessons.findMany({
      orderBy: desc(schema.lessons.createdAt),
      limit: 200,
    });
    const feedback = await db().query.agentFeedback.findMany({
      orderBy: desc(schema.agentFeedback.createdAt),
      limit: 50,
    });
    const body = `<p>Lessons come only from explicit instructions, corrections, or approved message edits. Nightly distillation is conservative and every lesson remains visible and reversible.</p>
      <form method="post" action="/admin/learning">
        <p><label>Note or standing instruction<br><textarea name="lesson" required maxlength="500" placeholder="Example: Keep first replies under three sentences and ask one question."></textarea></label></p>
        <p><label>Category <input type="text" name="category" value="general" maxlength="40"></label>
        <label><input type="checkbox" name="activate" value="yes"> Apply to agent behavior immediately</label>
        <button class="btn approve" type="submit">Save note</button></p>
      </form>
      <h3>Lessons and notes</h3>
      <table><tr><th>Instruction</th><th>Category</th><th>Source</th><th>Added</th><th>Status</th></tr>
      ${lessons.map((l) => `<tr><td>${esc(l.lesson)}</td><td>${esc(l.category)}</td><td>${esc(l.sourceType)}</td><td>${fmt(l.createdAt)}</td><td><form class="inline" method="post" action="/admin/learning/${l.id}/toggle"><button class="btn ${l.active ? "approve" : "neutral"}" type="submit">${l.active ? "Active" : "Inactive"}</button></form></td></tr>`).join("")}
      </table>${lessons.length ? "" : '<p class="muted">No lessons yet.</p>'}
      <h3>Raw edit evidence</h3><p class="muted">${feedback.length} recent draft-versus-sent examples; ${feedback.filter((f) => !f.distilled).length} still waiting for the nightly distiller.</p>`;
    reply.type("text/html");
    return layout("Learning & notes", body);
  });

  app.post<{ Body: { lesson?: string; category?: string; activate?: string } }>("/learning", async (req, reply) => {
    const lesson = (req.body?.lesson ?? "").trim();
    const category = (req.body?.category ?? "general").trim().slice(0, 40) || "general";
    if (lesson.length >= 8) {
      await db().insert(schema.lessons).values({
        lesson: lesson.slice(0, 500),
        category,
        sourceType: "instruction",
        active: req.body?.activate === "yes",
      });
    }
    return reply.redirect("/admin/learning");
  });

  app.post<{ Params: { id: string } }>("/learning/:id/toggle", async (req, reply) => {
    const lesson = await db().query.lessons.findFirst({ where: eq(schema.lessons.id, req.params.id) });
    if (lesson) {
      await db().update(schema.lessons).set({ active: !lesson.active }).where(eq(schema.lessons.id, lesson.id));
    }
    return reply.redirect("/admin/learning");
  });

  app.get("/showings", async (_req, reply) => {
    const rows = await db().query.showings.findMany({
      orderBy: desc(schema.showings.startsAt),
      limit: 100,
    });
    const body = `<table><tr><th>Property</th><th>When</th><th>Status</th></tr>
      ${rows
        .map(
          (s) =>
            `<tr><td><a href="/admin/leads/${s.leadId}">${esc(s.propertyAddress)}</a>${s.mlsNumber ? ` <span class="muted">MLS ${esc(s.mlsNumber)}</span>` : ""}</td>
             <td>${fmt(s.startsAt)}</td><td><span class="pill ${s.status}">${esc(s.status)}</span></td></tr>`,
        )
        .join("")}
    </table>${rows.length === 0 ? '<p class="muted">No showings yet.</p>' : ""}`;
    reply.type("text/html");
    return layout("Showings", body);
  });
}
