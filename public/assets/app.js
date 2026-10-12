// The booking page: service → day → time → details → confirmation (also shown for ?code=ABCD1234).
import { formatDay, formatDuration, formatTime, wallDate, weekdayNames } from './time.js';
import { $, api, errorText, formatMoney, formValues, h, ready, t } from './ui.js';

const state = {
  page: null,
  service: null,
  /** date → number of free times, for the chosen service */
  days: new Map(),
  month: '', // 'YYYY-MM' shown in the calendar
  date: '',
  time: '',
  slots: [],
};

const form = $('#booking-form');

function price(service) {
  return service.price === 0 ? t('service.free') : formatMoney(service.price, service.currency ?? state.page.currency);
}

/** Shows a step, moves focus to its title and scrolls it into view. */
function reveal(id) {
  const step = document.getElementById(id);
  step.hidden = false;
  const title = step.querySelector('.step-title');
  title.focus({ preventScroll: true });
  step.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
}

function hideFrom(...ids) {
  for (const id of ids) document.getElementById(id).hidden = true;
}

// 1. Services

function renderServices() {
  const services = state.page.services;
  $('#no-services').hidden = services.length > 0;
  $('#services').replaceChildren(
    ...services.map((service) =>
      h(
        'button',
        {
          type: 'button',
          class: 'service-card',
          'aria-pressed': String(state.service?.id === service.id),
          onclick: () => chooseService(service),
        },
        h('span', { class: 'service-name' }, service.name),
        service.description ? h('span', { class: 'service-description' }, service.description) : null,
        h(
          'span',
          { class: 'service-meta' },
          h('span', { class: 'chip' }, formatDuration(service.duration)),
          h('span', { class: `service-price${service.price === 0 ? ' free' : ''}` }, price(service)),
        ),
      ),
    ),
  );
}

async function chooseService(service) {
  state.service = service;
  state.date = '';
  state.time = '';
  renderServices();
  hideFrom('step-time', 'step-details');
  try {
    const { days } = await api(`/api/days?service=${service.id}`);
    state.days = new Map(days.map((day) => [day.date, day.slots]));
  } catch (failure) {
    state.days = new Map();
    $('#no-days').textContent = errorText(failure);
  }
  const first = [...state.days].find(([, slots]) => slots > 0)?.[0];
  state.month = (first ?? state.page.today).slice(0, 7);
  $('#no-days').hidden = first !== undefined;
  if (first === undefined && $('#no-days').textContent === '') $('#no-days').textContent = t('day.none');
  renderCalendar();
  reveal('step-day');
}

// 2. Day

function renderCalendar() {
  const [year, month] = state.month.split('-').map(Number);
  const firstOfMonth = `${state.month}-01`;
  $('#month-label').textContent = formatDay(firstOfMonth, { month: 'long', year: 'numeric' });
  // Monday first: blanks before the 1st
  const blanks = (wallDate(firstOfMonth).getUTCDay() + 6) % 7;
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const cells = Array.from({ length: blanks }, () => h('span', { class: 'calendar-blank' }));
  for (let day = 1; day <= daysInMonth; day++) {
    const date = `${state.month}-${String(day).padStart(2, '0')}`;
    const slots = state.days.get(date) ?? 0;
    const label = `${formatDay(date)}: ${slots > 0 ? t(slots === 1 ? 'day.slotsOne' : 'day.slotsMany', { count: slots }) : t('day.unavailable')}`;
    cells.push(
      h(
        'button',
        {
          type: 'button',
          class: `calendar-day${date === state.page.today ? ' today' : ''}`,
          disabled: slots === 0,
          'aria-pressed': String(date === state.date),
          'aria-label': label,
          title: label,
          onclick: () => chooseDay(date),
        },
        String(day),
      ),
    );
  }
  $('#calendar').replaceChildren(...cells);
  $('#prev-month').disabled = state.month <= state.page.today.slice(0, 7);
  $('#next-month').disabled = state.month >= state.page.lastDate.slice(0, 7);
}

function moveMonth(delta) {
  const [year, month] = state.month.split('-').map(Number);
  const next = new Date(Date.UTC(year, month - 1 + delta, 1));
  state.month = next.toISOString().slice(0, 7);
  renderCalendar();
}

async function chooseDay(date) {
  state.date = date;
  state.time = '';
  renderCalendar();
  hideFrom('step-details');
  await loadSlots();
  reveal('step-time');
}

// 3. Time

async function loadSlots() {
  try {
    const { slots } = await api(`/api/slots?service=${state.service.id}&date=${state.date}`);
    state.slots = slots;
  } catch (failure) {
    state.slots = [];
    $('#no-slots').textContent = errorText(failure);
  }
  $('#time-day').textContent = formatDay(state.date);
  $('#no-slots').hidden = state.slots.length > 0;
  if (state.slots.length === 0 && $('#no-slots').textContent === '') $('#no-slots').textContent = t('time.none');
  state.days.set(state.date, state.slots.length);
  renderSlots();
}

function renderSlots() {
  $('#slots').replaceChildren(
    ...state.slots.map((time) =>
      h('button', {
        type: 'button',
        class: 'slot',
        'aria-pressed': String(time === state.time),
        text: formatTime(time),
        onclick: () => chooseTime(time),
      }),
    ),
  );
}

function chooseTime(time) {
  state.time = time;
  renderSlots();
  $('#error').hidden = true;
  const end = new Date(wallDate(`${state.date}T${time}`).getTime() + state.service.duration * 60_000);
  renderSummary($('#summary'), {
    service_name: state.service.name,
    start_at: `${state.date}T${time}`,
    end_at: end.toISOString().slice(0, 16),
    price: state.service.price,
    currency: state.page.currency,
  });
  reveal('step-details');
}

// 4. Details and confirmation

function renderSummary(list, booking) {
  const rows = [
    [t('summary.service'), booking.service_name],
    [t('summary.date'), formatDay(booking.start_at.slice(0, 10))],
    [t('summary.time'), `${formatTime(booking.start_at)} – ${formatTime(booking.end_at)}`],
    [t('summary.price'), booking.price === 0 ? t('service.free') : formatMoney(booking.price, booking.currency)],
  ];
  list.replaceChildren(...rows.map(([term, value]) => h('div', {}, h('dt', {}, term), h('dd', {}, value))));
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const error = $('#error');
  error.hidden = true;
  if (!form.checkValidity()) {
    const invalid = form.querySelector(':invalid');
    error.textContent = t(`error.invalid_${invalid?.name === 'email' ? 'email' : invalid?.name === 'phone' ? 'phone' : 'name'}`);
    error.hidden = false;
    invalid?.focus();
    return;
  }
  const button = form.querySelector('button[type="submit"]');
  button.disabled = true;
  try {
    const { booking } = await api('/api/bookings', {
      method: 'POST',
      body: { ...formValues(form), service: state.service.id, date: state.date, time: state.time },
    });
    if (booking) showDone(booking);
  } catch (failure) {
    error.textContent = errorText(failure);
    error.hidden = false;
    // Someone else took this time a moment ago: show the times that are still free
    if (failure.code === 'slot_taken') {
      state.time = '';
      await loadSlots();
    }
  } finally {
    button.disabled = false;
  }
});

function showDone(booking) {
  const url = new URL(location.href);
  url.searchParams.set('code', booking.code);
  history.replaceState(null, '', url);
  $('#flow').hidden = true;
  $('#done').hidden = false;
  $('#done-title').textContent = t(`done.${booking.status}Title`);
  $('#done-text').textContent = t(`done.${booking.status}Text`);
  $('#done-icon').textContent = booking.status === 'cancelled' ? '✕' : '✓';
  $('#done-icon').classList.toggle('cancelled', booking.status === 'cancelled');
  $('#done-icon').classList.toggle('pending', booking.status === 'pending');
  $('#done-code').textContent = booking.code;
  renderSummary($('#done-summary'), booking);
  $('#add-calendar').href = `/api/bookings/${booking.code}.ics`;
  $('#add-calendar').hidden = booking.status === 'cancelled';
  $('#done-title').focus();
  window.scrollTo({ top: 0 });
}

function startOver() {
  const url = new URL(location.href);
  url.searchParams.delete('code');
  history.replaceState(null, '', url);
  form.reset();
  Object.assign(state, { service: null, date: '', time: '', slots: [], days: new Map() });
  hideFrom('done', 'step-day', 'step-time', 'step-details');
  $('#flow').hidden = false;
  renderServices();
  $('#step-service').scrollIntoView();
}

async function load() {
  ready();
  try {
    state.page = await api('/api/page');
  } catch (failure) {
    $('#business-name').textContent = t('page.defaultName');
    $('#no-services').textContent = errorText(failure);
    $('#no-services').hidden = false;
    return;
  }
  const page = state.page;
  document.title = page.business_name || t('page.title');
  $('#business-name').textContent = page.business_name || t('page.defaultName');
  $('#business-description').textContent = page.description || t('page.defaultDescription');
  $('#weekdays').replaceChildren(...weekdayNames().map((name) => h('span', {}, name)));
  const visitorZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (visitorZone && visitorZone !== page.timezone) {
    $('#tz-note').textContent = t('time.timezone', { zone: page.timezone.replaceAll('_', ' ') });
    $('#tz-note').hidden = false;
  }
  renderServices();

  // A link with ?code= shows that booking (and its current status)
  const code = new URLSearchParams(location.search).get('code');
  if (code && /^[0-9A-Za-z]{8}$/.test(code)) {
    try {
      const { booking } = await api(`/api/bookings/${encodeURIComponent(code)}`);
      showDone(booking);
    } catch {
      // Unknown code: just show the booking page
    }
  }
}

$('#prev-month').addEventListener('click', () => moveMonth(-1));
$('#next-month').addEventListener('click', () => moveMonth(1));
$('#book-again').addEventListener('click', startOver);

// The day's free times may change while the page is open: refresh them when the visitor comes back
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.service && state.date && !$('#step-time').hidden) loadSlots();
});

load();
