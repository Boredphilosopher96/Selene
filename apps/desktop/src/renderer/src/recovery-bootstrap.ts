import './renderer-recovery.css';

const root = document.getElementById('root');

if (root) {
  const surface = document.createElement('main');
  surface.className = 'renderer-recovery';
  surface.setAttribute('aria-labelledby', 'renderer-bootstrap-title');
  surface.setAttribute('aria-busy', 'true');

  const card = document.createElement('section');
  card.className = 'renderer-recovery__card';
  card.setAttribute('role', 'status');

  const mark = document.createElement('span');
  mark.className = 'renderer-recovery__mark';
  mark.setAttribute('aria-hidden', 'true');
  mark.textContent = 'S';

  const eyebrow = document.createElement('p');
  eyebrow.className = 'renderer-recovery__eyebrow';
  eyebrow.textContent = 'Selene desktop designer';

  const title = document.createElement('h1');
  title.id = 'renderer-bootstrap-title';
  title.textContent = 'Preparing your workspace';

  const detail = document.createElement('p');
  detail.textContent = 'Loading your local project and design tools…';

  const actions = document.createElement('div');
  actions.className = 'renderer-recovery__actions';
  actions.hidden = true;

  const reload = document.createElement('button');
  reload.type = 'button';
  reload.textContent = 'Reload window';
  reload.addEventListener('click', () => window.selene.workspace.reload());
  actions.append(reload);
  card.append(mark, eyebrow, title, detail, actions);
  surface.append(card);
  root.replaceChildren(surface);

  window.setTimeout(() => {
    if (!surface.isConnected) return;
    surface.setAttribute('aria-busy', 'false');
    card.setAttribute('role', 'alert');
    title.textContent = 'Selene could not finish opening';
    detail.textContent =
      'Your local project is safe. Reload the desktop window to try a clean renderer start.';
    actions.hidden = false;
    title.tabIndex = -1;
    title.focus();
  }, 5_000);
}
