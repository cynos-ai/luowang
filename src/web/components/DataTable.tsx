import type { ReactNode } from 'react';

export type DataColumn<Row> = {
  key: string;
  heading: string;
  render: (row: Row) => ReactNode;
};

export function DataTable<Row>({
  caption,
  columns,
  rows,
  rowKey,
}: {
  caption: string;
  columns: Array<DataColumn<Row>>;
  rows: Row[];
  rowKey: (row: Row) => string;
}) {
  return (
    <div className="table-scroll" tabIndex={0} role="region" aria-label={`${caption}，可横向滚动`}>
      <table className="data-table">
        <caption>{caption}</caption>
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column.key} scope="col">
                {column.heading}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={rowKey(row)}>
              {columns.map((column) => (
                <td key={column.key}>{column.render(row)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
