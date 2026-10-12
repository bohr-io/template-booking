// The admin: agenda, services, opening hours and settings.
import { addDays, formatDay, formatDuration, formatTime } from './time.js';
import { $, adminGate, api, busy, errorText, formatMoney, formatNumber, formValues, h, t, toast } from './ui.js';

const state = { currency: 'BRL', services: [], ranges: [] };

function selectTab(name) {
  for (const tab of document.querySelectorAll('[role="tab"]')) {
    const selected = tab.id === `tab-${name}`;
    tab.setAttribute('aria-selected', String(selected));
    document.getElementById(tab.getAttribute('aria-controls')).hidden = !selected;
  }
}

function money(cents, currency = state.currency) {
  return cents === 0 ? t('service.free') : formatMoney(cents, currency);
}

async function loadStats() {
  const stats = await api('/api/admin/stats');
  $('#stat-today').textContent = formatNumber(stats.today);
  $('#stat-week').textContent = formatNumber(stats.week);
  $('#stat-pending').textContent = formatNumber(stats.pending);
}

// Agenda

const STATUS_BADGE = { pending: 'warning', confirmed: 'success', cancelled: 'danger' };

async function loadAgenda() {
  const params = new URLSearchParams({ status: $('#status-filter').value, past: $('#show-past').checked ? '1' : '0' });
  const data = await api(`/api/admin/bookings?${params}`);
  const days = new Map();
  for (const booking of data.items) {
    const date = booking.start_at.slice(0, 10);
    if (!days.has(date)) days.set(date, []);
    days.get(date).push(booking);
  }
  $('#agenda').replaceChildren(
    ...[...days].map(([date, bookings]) =>
      h(
        'section',
        { class: `day-group${date < data.today ? ' past' : ''}` },
        h(
          'h3',
          { class: 'day-heading' },
          formatDay(date, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }),
          date === data.today ? h('span', { class: 'badge accent' }, t('agenda.today')) : null,
        ),
        h('ul', { class: 'admin-list' }, ...bookings.map((booking) => bookingItem(booking, data.now))),
      ),
    ),
  );
  $('#agenda-empty').hidden = data.items.length > 0;
}

function bookingItem(booking, now) {
  const actions = [];
  if (booking.status === 'pending') {
    actions.push(
      h('button', {
        class: 'btn small primary',
        type: 'button',
        text: t('agenda.confirm'),
        onclick: (event) => setStatus(booking, 'confirmed', event.currentTarget),
      }),
    );
  }
  if (booking.status !== 'cancelled') {
    actions.push(
      h('button', {
        class: 'btn small danger',
        type: 'button',
        text: t('agenda.cancel'),
        onclick: (event) => setStatus(booking, 'cancelled', event.currentTarget),
      }),
    );
  } else if (booking.end_at > now) {
    actions.push(
      h('button', {
        class: 'btn small',
        type: 'button',
        text: t('agenda.restore'),
        onclick: (event) => setStatus(booking, 'confirmed', event.currentTarget),
      }),
    );
  }
  const phone = booking.phone.replace(/[^0-9+]/g, '');
  return h(
    'li',
    { class: `booking-item ${booking.status}${booking.end_at <= now ? ' past' : ''}` },
    h(
      'div',
      { class: 'booking-time' },
      h('strong', {}, formatTime(booking.start_at)),
      h('span', { class: 'muted small' }, formatTime(booking.end_at)),
    ),
    h(
      'div',
      { class: 'booking-main' },
      h(
        'div',
        { class: 'row tight' },
        h('strong', {}, booking.service_name),
        h('span', { class: `badge ${STATUS_BADGE[booking.status]}` }, t(`status.${booking.status}`)),
        h('span', { class: 'muted small' }, `${formatDuration(booking.duration)} · ${money(booking.price, booking.currency)}`),
      ),
      h('div', { class: 'customer' }, booking.name),
      h(
        'div',
        { class: 'contact small' },
        h('a', { href: `mailto:${booking.email}` }, booking.email),
        phone ? h('a', { href: `tel:${phone}` }, booking.phone) : null,
      ),
      booking.note ? h('p', { class: 'booking-note small' }, booking.note) : null,
      h('span', { class: 'muted small' }, t('agenda.code', { code: booking.code })),
    ),
    h('div', { class: 'booking-actions' }, ...actions),
  );
}

async function setStatus(booking, status, button) {
  const when = `${formatDay(booking.start_at.slice(0, 10))} ${formatTime(booking.start_at)}`;
  if (status === 'cancelled' && !confirm(t('agenda.cancelConfirm', { name: booking.name, when }))) return;
  await busy(button, async () => {
    await api(`/api/admin/bookings/${booking.id}`, { method: 'PATCH', body: { status } });
    toast(t(`agenda.done.${status}`));
    await Promise.all([loadAgenda(), loadStats()]);
  });
}

// Services

async function loadServices() {
  const { items } = await api('/api/admin/services');
  state.services = items;
  renderServices();
}

function renderServices(focus) {
  const list = state.services;
  $('#services-empty').hidden = list.length > 0;
  $('#service-list').replaceChildren(
    ...list.map((service, index) =>
      h(
        'li',
        { class: `service-row${service.active ? '' : ' inactive'}` },
        h(
          'div',
          { class: 'reorder' },
          h('button', {
            class: 'btn small ghost icon',
            type: 'button',
            text: '↑',
            'aria-label': t('services.moveUp', { name: service.name }),
            disabled: index === 0,
            dataset: { move: `${service.id}:up` },
            onclick: () => moveService(index, -1, 'up'),
          }),
          h('button', {
            class: 'btn small ghost icon',
            type: 'button',
            text: '↓',
            'aria-label': t('services.moveDown', { name: service.name }),
            disabled: index === list.length - 1,
            dataset: { move: `${service.id}:down` },
            onclick: () => moveService(index, 1, 'down'),
          }),
        ),
        h(
          'div',
          { class: 'grow service-info' },
          h(
            'div',
            { class: 'row tight' },
            h('strong', {}, service.name),
            service.active ? null : h('span', { class: 'badge' }, t('services.hidden')),
          ),
          h('span', { class: 'muted small' }, `${formatDuration(service.duration)} · ${money(service.price)}`),
          service.description ? h('p', { class: 'small service-description' }, service.description) : null,
        ),
        h(
          'label',
          { class: 'check small' },
          h('input', {
            type: 'checkbox',
            checked: Boolean(service.active),
            onchange: (event) => toggleService(service, event.currentTarget),
          }),
          h('span', {}, t('services.active')),
        ),
        h(
          'div',
          { class: 'row tight' },
          h('button', { class: 'btn small', type: 'button', text: t('services.edit'), onclick: () => openService(service) }),
          h('button', {
            class: 'btn small danger',
            type: 'button',
            text: t('common.delete'),
            onclick: (event) => removeService(service, event.currentTarget),
          }),
        ),
      ),
    ),
  );
  if (focus) {
    const button = document.querySelector(`[data-move="${focus}"]`);
    // At the top or bottom the pressed button is disabled: focus its sibling
    (button?.disabled ? button.parentElement.querySelector('button:not(:disabled)') : button)?.focus();
  }
}

async function moveService(index, delta, direction) {
  const list = state.services;
  const target = index + delta;
  if (target < 0 || target >= list.length) return;
  [list[index], list[target]] = [list[target], list[index]];
  renderServices(`${list[target].id}:${direction}`);
  await busy(null, () => api('/api/admin/services/order', { method: 'PUT', body: { ids: list.map((service) => service.id) } }));
}

function serviceBody(service) {
  const { name, description, duration, price } = service;
  return { name, description, duration, price, active: Boolean(service.active) };
}

async function toggleService(service, input) {
  await busy(input, async () => {
    await api(`/api/admin/services/${service.id}`, {
      method: 'PUT',
      body: { ...serviceBody(service), active: input.checked },
    });
    toast(t(input.checked ? 'services.shown' : 'services.hiddenDone'));
    await loadServices();
  });
}

async function removeService(service, button) {
  if (!confirm(t('services.deleteConfirm', { name: service.name }))) return;
  await busy(button, async () => {
    await api(`/api/admin/services/${service.id}`, { method: 'DELETE' });
    toast(t('services.deleted'));
    await loadServices();
  });
}

let editing = null;

function openService(service = null) {
  editing = service;
  const form = $('#service-form');
  form.reset();
  $('#service-error').hidden = true;
  $('#service-dialog-title').textContent = t(service ? 'services.editTitle' : 'services.newTitle');
  form.elements.name.value = service?.name ?? '';
  form.elements.description.value = service?.description ?? '';
  form.elements.duration.value = String(service?.duration ?? 30);
  form.elements.price.value = ((service?.price ?? 0) / 100).toFixed(2);
  form.elements.active.checked = service ? Boolean(service.active) : true;
  $('#service-dialog').showModal();
  form.elements.name.focus();
}

async function saveService(event) {
  event.preventDefault();
  const form = event.target;
  const error = $('#service-error');
  error.hidden = true;
  const values = formValues(form);
  const body = {
    name: values.name,
    description: values.description,
    duration: Number(values.duration),
    // The price is typed in units (12.50) and stored in cents (1250)
    price: Math.round(Number(String(values.price).replace(',', '.')) * 100),
    active: values.active,
  };
  const button = form.querySelector('button[type="submit"]');
  button.disabled = true;
  try {
    if (editing) await api(`/api/admin/services/${editing.id}`, { method: 'PUT', body });
    else await api('/api/admin/services', { method: 'POST', body });
    $('#service-dialog').close();
    toast(t('common.saved'));
    await loadServices();
  } catch (failure) {
    if (failure.code === 'unauthorized') location.reload();
    error.textContent = errorText(failure);
    error.hidden = false;
  } finally {
    button.disabled = false;
  }
}

// Opening hours and days off

/** Weekdays from Monday (1) to Sunday (0), with their names. */
function weekdays() {
  return Array.from({ length: 7 }, (_, index) => ({
    weekday: (index + 1) % 7,
    name: formatDay(addDays('2024-01-01', index), { weekday: 'long' }),
  }));
}

async function loadHours() {
  const data = await api('/api/admin/availability');
  state.ranges = data.ranges;
  renderWeek();
  renderDaysOff(data.days_off);
}

/** time inputs can't show '24:00': midnight at the end of the day is shown (and sent) as '00:00'. */
const shown = (time) => (time === '24:00' ? '00:00' : time);

function renderWeek(focusDay) {
  $('#week').replaceChildren(
    ...weekdays().map(({ weekday, name }) => {
      const ranges = state.ranges.filter((range) => range.weekday === weekday);
      return h(
        'fieldset',
        { class: 'day-hours' },
        h('legend', {}, name),
        h(
          'div',
          { class: 'ranges' },
          ranges.length === 0 ? h('span', { class: 'muted small closed' }, t('hours.closed')) : null,
          ...ranges.map((range) =>
            h(
              'div',
              { class: 'range' },
              h('input', {
                type: 'time',
                step: 300,
                required: true,
                value: shown(range.start_time),
                'aria-label': t('hours.from', { day: name }),
                oninput: (event) => {
                  range.start_time = event.target.value;
                },
              }),
              h('span', { 'aria-hidden': 'true' }, '–'),
              h('input', {
                type: 'time',
                step: 300,
                required: true,
                value: shown(range.end_time),
                'aria-label': t('hours.to', { day: name }),
                oninput: (event) => {
                  range.end_time = event.target.value;
                },
              }),
              h('button', {
                class: 'btn small ghost icon danger',
                type: 'button',
                text: '✕',
                'aria-label': t('hours.remove', { day: name }),
                onclick: () => {
                  state.ranges = state.ranges.filter((item) => item !== range);
                  renderWeek(weekday);
                },
              }),
            ),
          ),
        ),
        h('button', {
          class: 'btn small ghost add-range',
          type: 'button',
          text: t('hours.add'),
          'aria-label': t('hours.addLabel', { day: name }),
          dataset: { day: String(weekday) },
          onclick: () => addRange(weekday),
        }),
      );
    }),
  );
  if (focusDay !== undefined) document.querySelector(`.add-range[data-day="${focusDay}"]`)?.focus();
}

function addRange(weekday) {
  const ranges = state.ranges.filter((range) => range.weekday === weekday);
  const last = ranges.at(-1);
  let range = { weekday, start_time: '09:00', end_time: '18:00' };
  if (last) {
    // One hour after the last range, until midnight
    const [hour, minute] = shown(last.end_time).split(':').map(Number);
    const end = Math.min(hour + 1, 24);
    range = { weekday, start_time: last.end_time, end_time: `${String(end).padStart(2, '0')}:${String(minute).padStart(2, '0')}` };
    if (end === 24) range.end_time = '24:00';
  }
  state.ranges.push(range);
  renderWeek();
  const inputs = [...document.querySelectorAll(`.add-range[data-day="${weekday}"]`)].at(0)?.parentElement.querySelectorAll('input');
  inputs?.[inputs.length - 2]?.focus();
}

function renderDaysOff(daysOff) {
  $('#days-off-empty').hidden = daysOff.length > 0;
  $('#days-off').replaceChildren(
    ...daysOff.map((day) =>
      h(
        'li',
        { class: 'day-off' },
        h('strong', {}, formatDay(day.date, { weekday: 'short', day: 'numeric', month: 'long', year: 'numeric' })),
        h('span', { class: 'muted grow' }, day.note),
        h('button', {
          class: 'btn small danger',
          type: 'button',
          text: t('daysOff.remove'),
          onclick: (event) =>
            busy(event.currentTarget, async () => {
              await api(`/api/admin/days-off/${day.date}`, { method: 'DELETE' });
              toast(t('daysOff.removed'));
              await loadHours();
            }),
        }),
      ),
    ),
  );
}

// Settings

async function loadSettings() {
  const settings = await api('/api/admin/settings');
  state.currency = settings.currency;
  const form = $('#settings');
  for (const [name, value] of Object.entries(settings)) {
    const input = form.elements[name];
    if (!input) continue;
    if (input.type === 'checkbox') input.checked = value;
    else input.value = String(value);
  }
}

async function start() {
  for (const tab of document.querySelectorAll('[role="tab"]')) {
    tab.addEventListener('click', () => selectTab(tab.id.slice(4)));
  }
  $('#status-filter').addEventListener('change', () => busy(null, loadAgenda));
  $('#show-past').addEventListener('change', () => busy(null, loadAgenda));

  $('#new-service').addEventListener('click', () => openService());
  $('#service-form').addEventListener('submit', saveService);
  $('#service-cancel').addEventListener('click', () => $('#service-dialog').close());

  $('#hours-form').addEventListener('submit', (event) => {
    event.preventDefault();
    if (!event.target.reportValidity()) return;
    busy(event.submitter, async () => {
      const { ranges } = await api('/api/admin/availability', { method: 'PUT', body: { ranges: state.ranges } });
      state.ranges = ranges;
      renderWeek();
      toast(t('common.saved'));
    });
  });
  $('#day-off-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const form = event.target;
    if (!form.reportValidity()) return;
    busy(event.submitter, async () => {
      await api('/api/admin/days-off', { method: 'POST', body: formValues(form) });
      form.reset();
      toast(t('daysOff.added'));
      await loadHours();
    });
  });

  if (typeof Intl.supportedValuesOf === 'function') {
    $('#timezones').replaceChildren(...Intl.supportedValuesOf('timeZone').map((zone) => h('option', { value: zone })));
  }
  $('#settings').addEventListener('submit', (event) => {
    event.preventDefault();
    busy(event.submitter, async () => {
      const settings = await api('/api/admin/settings', { method: 'PUT', body: formValues(event.target) });
      state.currency = settings.currency;
      toast(t('common.saved'));
      await Promise.all([loadServices(), loadAgenda(), loadStats()]);
    });
  });

  await busy(null, async () => {
    await loadSettings();
    await Promise.all([loadStats(), loadAgenda(), loadServices(), loadHours()]);
  });
}

adminGate(start);
