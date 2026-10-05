import type { HistorySummary } from '../history/downloadHistory';
import { formatBytes, formatTime, plural } from '../lib/format';
import { StatusBadge } from './components';
import CountUp from './reactbits/CountUp';

export function HistoryPanel({ summary, fileCount, onClear }: { summary: HistorySummary; fileCount: number; onClear(): void }) {
  const hasAnything = summary.successfulCount + summary.saveUnconfirmed.length + summary.unconfirmed.length > 0;
  return (
    <section className="card history" aria-labelledby="history-heading">
      <div className="section-head">
        <h2 id="history-heading">Successful downloads</h2>
        {hasAnything && (
          <button type="button" className="button ghost small" onClick={onClear}>
            Clear history
          </button>
        )}
      </div>

      <div className="history-stats" aria-live="polite">
        <div className="stat">
          <CountUp className="stat-value" to={summary.completeReceivers} />
          <span className="stat-label">
            {summary.completeReceivers === 1 ? 'receiver has' : 'receivers have'} all {plural(fileCount, 'file')}
          </span>
        </div>
        <div className="stat">
          <CountUp className="stat-value" to={summary.successfulCount} />
          <span className="stat-label">confirmed {summary.successfulCount === 1 ? 'download' : 'downloads'}</span>
        </div>
      </div>

      {summary.successful.length === 0 ? (
        <p className="muted">
          Downloads appear here once a receiver’s browser confirms the file was completely received, checked and saved.
        </p>
      ) : (
        <ul className="history-groups">
          {summary.successful.map((group) => (
            <li key={group.receiverId} className="history-group">
              <div className="history-group-head">
                <strong>{group.receiverName}</strong>
                {group.receivedAll ? (
                  <StatusBadge tone="success">Received all files</StatusBadge>
                ) : (
                  <span className="muted small-text">
                    {group.records.length} of {plural(fileCount, 'file')}
                  </span>
                )}
              </div>
              <table className="history-table">
                <caption className="visually-hidden">Files confirmed by {group.receiverName}</caption>
                <thead>
                  <tr>
                    <th scope="col">File</th>
                    <th scope="col">Size</th>
                    <th scope="col">Completed</th>
                  </tr>
                </thead>
                <tbody>
                  {group.records.map((r) => (
                    <tr key={r.fileId}>
                      <td className="file-name" title={r.fileName}>
                        {r.fileName}
                      </td>
                      <td className="mono">{formatBytes(r.size)}</td>
                      <td className="mono">{formatTime(r.completedAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </li>
          ))}
        </ul>
      )}

      {summary.saveUnconfirmed.length > 0 && (
        <OtherOutcomes
          title="Delivered to browser — save unconfirmed"
          explanation="These receivers used their browser’s download fallback. The file reached their browser, but the app can’t confirm it was saved. Not counted as successful downloads."
          records={summary.saveUnconfirmed}
        />
      )}
      {summary.unconfirmed.length > 0 && (
        <OtherOutcomes
          title="Unconfirmed"
          explanation="All data was sent, but the connection ended before the receiver confirmed the save. The file may or may not have been saved."
          records={summary.unconfirmed}
        />
      )}

      <p className="muted small-text fine-print">
        Confirmations are reported by the receiver’s DirectShare page after it finished writing the file. They are not
        independent proof that the file is still on the device. History is kept only in this tab.
      </p>
    </section>
  );
}

function OtherOutcomes({ title, explanation, records }: { title: string; explanation: string; records: HistorySummary['unconfirmed'] }) {
  return (
    <div className="other-outcomes">
      <h3>
        <StatusBadge tone="warning">{title}</StatusBadge>
      </h3>
      <p className="muted small-text">{explanation}</p>
      <table className="history-table">
        <thead>
          <tr>
            <th scope="col">File</th>
            <th scope="col">Receiver</th>
            <th scope="col">Size</th>
            <th scope="col">Time</th>
          </tr>
        </thead>
        <tbody>
          {records.map((r) => (
            <tr key={`${r.receiverId}-${r.fileId}`}>
              <td className="file-name" title={r.fileName}>
                {r.fileName}
              </td>
              <td>{r.receiverName}</td>
              <td className="mono">{formatBytes(r.size)}</td>
              <td className="mono">{formatTime(r.completedAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
