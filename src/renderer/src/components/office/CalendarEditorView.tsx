import { useState } from 'react'
import type { CalendarDocumentModel, CalendarEvent } from '../../../../shared/office/officeModels'
import {
  WEEKDAY_LABELS_MONDAY_FIRST,
  buildMonthGrid,
  eventsByDay,
  monthLabel,
  sortedAgenda
} from '../../../../shared/office/calendarGrid'
import { addDaysToIsoDate } from '../../../../shared/office/icsCodec'

interface CalendarEditorViewProps {
  model: CalendarDocumentModel
  onChange: (next: CalendarDocumentModel) => void
  /** Test seam: pin the visible month (defaults to the first event, else today). */
  initialMonth?: { year: number; monthIndex: number }
}

const todayMonth = (): { year: number; monthIndex: number } => {
  const now = new Date()
  return { year: now.getFullYear(), monthIndex: now.getMonth() }
}

const monthOfFirstEvent = (
  model: CalendarDocumentModel
): { year: number; monthIndex: number } | null => {
  const first = [...model.events].sort((a, b) => (a.start < b.start ? -1 : 1))[0]
  if (!first) return null
  const match = /^(\d{4})-(\d{2})/.exec(first.start)
  if (!match) return null
  return { year: Number(match[1]), monthIndex: Number(match[2]) - 1 }
}

let eventUidCounter = 0
const newEventUid = (): string => {
  eventUidCounter += 1
  return `taskwraith-${Date.now().toString(36)}-${eventUidCounter}`
}

export function CalendarEditorView({ model, onChange, initialMonth }: CalendarEditorViewProps) {
  const [cursor, setCursor] = useState(
    () => initialMonth ?? monthOfFirstEvent(model) ?? todayMonth()
  )
  const [selectedDay, setSelectedDay] = useState<string | null>(null)
  const [selectedUid, setSelectedUid] = useState<string | null>(null)

  const weeks = buildMonthGrid(cursor.year, cursor.monthIndex, 1)
  const byDay = eventsByDay(model.events)
  const selectedEvent = model.events.find((event) => event.uid === selectedUid) ?? null

  const replaceEvents = (events: CalendarEvent[]): void => {
    onChange({ ...model, events })
  }

  const updateEvent = (uid: string, patch: Partial<CalendarEvent>): void => {
    replaceEvents(model.events.map((event) => (event.uid === uid ? { ...event, ...patch } : event)))
  }

  const addEvent = (): void => {
    const day = selectedDay ?? weeks[0]?.find((cell) => cell.inMonth)?.iso
    if (!day) return
    const event: CalendarEvent = {
      uid: newEventUid(),
      title: 'New event',
      start: `${day}T09:00`,
      end: `${day}T10:00`,
      allDay: false
    }
    replaceEvents([...model.events, event])
    setSelectedDay(day)
    setSelectedUid(event.uid)
  }

  const deleteEvent = (uid: string): void => {
    replaceEvents(model.events.filter((event) => event.uid !== uid))
    setSelectedUid(null)
  }

  const toggleAllDay = (event: CalendarEvent, allDay: boolean): void => {
    if (allDay === event.allDay) return
    if (allDay) {
      const day = event.start.slice(0, 10)
      updateEvent(event.uid, { allDay: true, start: day, end: addDaysToIsoDate(day, 1) })
    } else {
      const day = event.start.slice(0, 10)
      updateEvent(event.uid, { allDay: false, start: `${day}T09:00`, end: `${day}T10:00` })
    }
  }

  const shiftMonth = (delta: number): void => {
    const next = cursor.monthIndex + delta
    const year = cursor.year + Math.floor(next / 12)
    setCursor({ year, monthIndex: ((next % 12) + 12) % 12 })
  }

  const dayEvents = selectedDay ? (byDay.get(selectedDay) ?? []) : []

  return (
    <div className="office-calendar-editor">
      <div className="office-editor-toolbar" role="toolbar" aria-label="Calendar controls">
        <button type="button" className="office-toolbar-button" onClick={() => shiftMonth(-1)}>
          ‹
        </button>
        <span className="office-calendar-month-label">
          {monthLabel(cursor.year, cursor.monthIndex)}
        </span>
        <button type="button" className="office-toolbar-button" onClick={() => shiftMonth(1)}>
          ›
        </button>
        <span className="office-toolbar-divider" aria-hidden="true" />
        <button type="button" className="office-toolbar-button" onClick={addEvent}>
          + Event
        </button>
        {model.calendarName ? (
          <span className="office-calendar-name">{model.calendarName}</span>
        ) : null}
      </div>

      <div className="office-calendar-grid" role="grid" aria-label="Month">
        {WEEKDAY_LABELS_MONDAY_FIRST.map((weekday) => (
          <span key={weekday} className="office-calendar-weekday" role="columnheader">
            {weekday}
          </span>
        ))}
        {weeks.flat().map((cell) => {
          const cellEvents = byDay.get(cell.iso) ?? []
          const isSelected = cell.iso === selectedDay
          return (
            <button
              key={cell.iso}
              type="button"
              role="gridcell"
              className={[
                'office-calendar-day',
                cell.inMonth ? '' : 'is-outside',
                isSelected ? 'is-selected' : '',
                cellEvents.length > 0 ? 'has-events' : ''
              ]
                .filter(Boolean)
                .join(' ')}
              onClick={() => setSelectedDay(cell.iso)}
            >
              <span className="office-calendar-daynum">{cell.dayOfMonth}</span>
              {cellEvents.slice(0, 3).map((event) => (
                <span key={event.uid} className="office-calendar-chip" title={event.title}>
                  {event.title || '(untitled)'}
                </span>
              ))}
              {cellEvents.length > 3 ? (
                <span className="office-calendar-more">+{cellEvents.length - 3}</span>
              ) : null}
            </button>
          )
        })}
      </div>

      <div className="office-calendar-detail">
        {selectedDay ? (
          <div className="office-calendar-daylist">
            <h4>{selectedDay}</h4>
            {dayEvents.length === 0 ? (
              <p className="office-muted">No events. “+ Event” adds one here.</p>
            ) : (
              dayEvents.map((event) => (
                <button
                  key={event.uid}
                  type="button"
                  className={`office-calendar-daylist-item${
                    event.uid === selectedUid ? ' is-active' : ''
                  }`}
                  onClick={() => setSelectedUid(event.uid)}
                >
                  <span>{event.allDay ? 'All day' : event.start.slice(11)}</span>
                  <span>{event.title || '(untitled)'}</span>
                </button>
              ))
            )}
          </div>
        ) : (
          <div className="office-calendar-daylist">
            <h4>Agenda</h4>
            {sortedAgenda(model.events)
              .slice(0, 8)
              .map(([day, events]) => (
                <button
                  key={day}
                  type="button"
                  className="office-calendar-daylist-item"
                  onClick={() => setSelectedDay(day)}
                >
                  <span>{day}</span>
                  <span>
                    {events.length} event{events.length === 1 ? '' : 's'}
                  </span>
                </button>
              ))}
            {model.events.length === 0 ? (
              <p className="office-muted">Empty calendar. “+ Event” creates the first entry.</p>
            ) : null}
          </div>
        )}

        {selectedEvent ? (
          <div className="office-calendar-form">
            <label className="office-field">
              <span>Title</span>
              <input
                value={selectedEvent.title}
                onChange={(event) => updateEvent(selectedEvent.uid, { title: event.target.value })}
              />
            </label>
            <label className="office-field office-field-inline">
              <input
                type="checkbox"
                checked={selectedEvent.allDay}
                onChange={(event) => toggleAllDay(selectedEvent, event.target.checked)}
              />
              <span>All day</span>
            </label>
            {selectedEvent.allDay ? (
              <div className="office-field-row">
                <label className="office-field">
                  <span>Start date</span>
                  <input
                    type="date"
                    value={selectedEvent.start}
                    onChange={(event) =>
                      updateEvent(selectedEvent.uid, { start: event.target.value })
                    }
                  />
                </label>
                <label className="office-field">
                  <span>End date (exclusive)</span>
                  <input
                    type="date"
                    value={selectedEvent.end}
                    onChange={(event) =>
                      updateEvent(selectedEvent.uid, { end: event.target.value })
                    }
                  />
                </label>
              </div>
            ) : (
              <div className="office-field-row">
                <label className="office-field">
                  <span>Start</span>
                  <input
                    type="datetime-local"
                    value={selectedEvent.start}
                    onChange={(event) =>
                      updateEvent(selectedEvent.uid, { start: event.target.value })
                    }
                  />
                </label>
                <label className="office-field">
                  <span>End</span>
                  <input
                    type="datetime-local"
                    value={selectedEvent.end}
                    onChange={(event) =>
                      updateEvent(selectedEvent.uid, { end: event.target.value })
                    }
                  />
                </label>
              </div>
            )}
            <label className="office-field">
              <span>Location</span>
              <input
                value={selectedEvent.location ?? ''}
                onChange={(event) =>
                  updateEvent(selectedEvent.uid, { location: event.target.value })
                }
              />
            </label>
            <label className="office-field">
              <span>Description</span>
              <textarea
                value={selectedEvent.description ?? ''}
                onChange={(event) =>
                  updateEvent(selectedEvent.uid, { description: event.target.value })
                }
              />
            </label>
            {selectedEvent.extraProperties?.length ? (
              <p className="office-muted office-calendar-extras">
                {selectedEvent.extraProperties.length} imported propert
                {selectedEvent.extraProperties.length === 1 ? 'y' : 'ies'} (recurrence, alarms…)
                preserved on save.
              </p>
            ) : null}
            <div className="office-field-row">
              <button
                type="button"
                className="office-toolbar-button office-danger"
                onClick={() => deleteEvent(selectedEvent.uid)}
              >
                Delete event
              </button>
              <button
                type="button"
                className="office-toolbar-button"
                onClick={() => setSelectedUid(null)}
              >
                Done
              </button>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  )
}
