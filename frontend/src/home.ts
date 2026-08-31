import { registerServiceWorker } from "./pwa";
import { shouldOpenSignupGuide, signupNotice } from "./signup-state";

void registerServiceWorker();

const intro = document.querySelector<HTMLElement>("[data-connect-intro]");
const openIntro = document.querySelector<HTMLButtonElement>("[data-connect-intro-open]");
const closeIntro = intro?.querySelector<HTMLButtonElement>("[data-connect-intro-close]");
const introNotice = intro?.querySelector<HTMLElement>("[data-connect-intro-notice]");
let returnFocus: HTMLElement | null = null;

const focusable = () => [...(intro?.querySelectorAll<HTMLElement>('a[href], button:not([disabled])') ?? [])];
const close = () => {
  if (!intro) return;
  intro.hidden = true;
  document.body.classList.remove("has-connect-intro");
  returnFocus?.focus();
};

const open = () => {
  if (!intro) return;
  returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : openIntro;
  intro.hidden = false;
  document.body.classList.add("has-connect-intro");
  closeIntro?.focus();
};

openIntro?.addEventListener("click", open);
closeIntro?.addEventListener("click", close);
intro?.addEventListener("click", (event) => {
  if (event.target === intro) close();
});
intro?.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    close();
    return;
  }
  if (event.key !== "Tab") return;
  const controls = focusable();
  if (!controls.length) return;
  const first = controls[0];
  const last = controls.at(-1)!;
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
});

const notice = signupNotice(location.search);
if (notice && introNotice) {
  introNotice.textContent = notice;
  introNotice.hidden = false;
}
if (shouldOpenSignupGuide(location.search)) {
  open();
  const cleanUrl = new URL(location.href);
  for (const key of ["connect", "oauth", "setup"]) cleanUrl.searchParams.delete(key);
  history.replaceState(null, "", `${cleanUrl.pathname}${cleanUrl.search}${cleanUrl.hash}`);
}
