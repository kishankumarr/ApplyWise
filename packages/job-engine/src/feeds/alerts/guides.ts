/**
 * How to switch on email job alerts on each supported site, shown on the "Job sources" page.
 * `searchUrlTemplate` placeholders ({keywords}, {location}) take URL-encoded values; the results
 * page it opens has the site's own "create alert" control. Nothing here is ever fetched by us.
 */

export interface AlertSetupGuide {
  platform: string;
  label: string;
  createAlertUrl: string;
  steps: string[];
  searchUrlTemplate?: string;
}

export const ALERT_SETUP_GUIDES: AlertSetupGuide[] = [
  {
    platform: "LINKEDIN",
    label: "LinkedIn",
    createAlertUrl: "https://www.linkedin.com/jobs/",
    searchUrlTemplate: "https://www.linkedin.com/jobs/search/?keywords={keywords}&location={location}",
    steps: [
      "Search LinkedIn Jobs for a job title and a city (or India).",
      "Turn on the job alert toggle above the results.",
      "Open Manage alerts and choose Daily and Email.",
      "You can keep up to 20 job alerts.",
    ],
  },
  {
    platform: "INDEED",
    label: "Indeed",
    createAlertUrl: "https://in.indeed.com/",
    searchUrlTemplate: "https://in.indeed.com/jobs?q={keywords}&l={location}",
    steps: [
      "Sign in to Indeed.",
      "Search for a job title and a city.",
      "Scroll to the bottom of the first results page and click Activate to get new jobs by email.",
      "Change daily/weekly or pause alerts in Indeed's notification settings.",
    ],
  },
  {
    platform: "NAUKRI",
    label: "Naukri",
    createAlertUrl: "https://www.naukri.com/free-job-alerts",
    steps: [
      "Open Naukri's Create Job Alert form, or run a search and click Set As Alert.",
      "Enter keywords, location, experience and expected salary, name the alert and save. You can have up to 5 alerts.",
      "In My Naukri > Settings > Communication and Privacy, keep Job Opportunities and Communication from recruiters switched on.",
      "Set your job search status to actively looking; otherwise Naukri sends only one recommendation email a week.",
    ],
  },
  {
    platform: "FOUNDIT",
    label: "Foundit",
    createAlertUrl: "https://www.foundit.in/create-free-job-alert.html",
    steps: [
      "Open Foundit's Create Job Alert page and give the alert a name.",
      "Add skills, years of experience and your preferred location.",
      "Pick up to 2 industries, functions and roles.",
      "Choose daily or weekly and click Create New Agent. You can have up to 5 alerts.",
    ],
  },
  {
    platform: "INSTAHYRE",
    label: "Instahyre",
    createAlertUrl: "https://www.instahyre.com/candidate/opportunities/",
    steps: [
      "Instahyre has no saved-search alerts: it emails you openings that match your profile.",
      "Complete your profile and Job Preferences.",
      "Set Job search status to actively looking so matching openings are emailed to you.",
    ],
  },
  {
    platform: "CUTSHORT",
    label: "Cutshort",
    createAlertUrl: "https://cutshort.io/jobs",
    steps: [
      "Complete your Cutshort profile and set your status to looking.",
      "In account settings, turn on email job recommendations and pick how often you get them.",
      "Cutshort sends a few curated jobs; reply-to-apply is always your own choice.",
    ],
  },
  {
    platform: "WELLFOUND",
    label: "Wellfound",
    createAlertUrl: "https://wellfound.com/jobs",
    steps: [
      "Sign in and open Jobs, then set your search and filters.",
      "Click the pencil icon next to the saved search and give it a title.",
      "Switch on Get job alerts for this search and choose daily or weekly.",
    ],
  },
  {
    platform: "GLASSDOOR",
    label: "Glassdoor",
    createAlertUrl: "https://www.glassdoor.co.in/Job/index.htm",
    steps: [
      "Search Glassdoor jobs for a title and a city.",
      "Turn on the job alert toggle on the results page.",
      "Glassdoor now signs in with Indeed accounts, so alerts may also arrive from Indeed.",
    ],
  },
  {
    platform: "HIRIST",
    label: "Hirist / iimjobs",
    createAlertUrl: "https://www.hirist.tech/",
    steps: [
      "Sign in to hirist.tech (tech jobs) or iimjobs.com (management jobs).",
      "Complete your profile and job preferences: role, experience and locations.",
      "Keep job recommendation emails switched on in your account settings.",
    ],
  },
];
