export type OrdersPageState = 'loading' | 'empty' | 'error' | 'success';

export interface OrdersPageProps {
  readonly state: OrdersPageState;
  readonly disabled?: boolean;
  readonly compact?: boolean;
  readonly onCreateOrder: () => void;
  readonly onRestoreOrders: () => void;
  readonly onShowEmpty: () => void;
}

/** A real product-page component shared by the executable prototype and CSF catalog. */
export function OrdersPage({
  state,
  disabled = false,
  compact = false,
  onCreateOrder,
  onRestoreOrders,
  onShowEmpty
}: OrdersPageProps) {
  return (
    <article
      className="prototype-page prototype-page--orders"
      aria-label="Orders prototype page"
      style={compact ? { maxWidth: 360 } : undefined}
    >
      <div className="prototype-page__bar">
        <strong>Northstar</strong>
        <span>Orders</span>
        <button type="button" disabled={disabled} onClick={onCreateOrder}>
          Create order
        </button>
      </div>
      <h3>Orders</h3>
      {state === 'loading' ? <p aria-busy="true">Loading orders…</p> : null}
      {state === 'error' ? (
        <section className="prototype-page__empty" role="alert">
          <strong>Orders could not be loaded.</strong>
          <button type="button" disabled={disabled} onClick={onRestoreOrders}>
            Retry
          </button>
        </section>
      ) : null}
      {state === 'empty' ? (
        <section className="prototype-page__empty">
          <strong>No orders match this filter.</strong>
          <button type="button" disabled={disabled} onClick={onRestoreOrders}>
            Restore orders
          </button>
        </section>
      ) : null}
      {state === 'success' ? (
        <ul className="prototype-page__orders">
          {ordersPrototypeFixture.map((order) => (
            <li key={order.id}>
              <strong>#{order.id}</strong>
              <span>
                {order.customer} · {order.amount}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      <button
        type="button"
        className="prototype-page__secondary"
        disabled={disabled}
        onClick={onShowEmpty}
      >
        Show empty
      </button>
    </article>
  );
}

export interface NewOrderPageProps {
  readonly saved: boolean;
  readonly onSave: () => void;
  readonly onCancel: () => void;
  readonly onDismiss: () => void;
}

export function NewOrderPage({ saved, onSave, onCancel, onDismiss }: NewOrderPageProps) {
  return (
    <article
      className="prototype-page prototype-page--new-order"
      aria-label="New order prototype page"
    >
      <h3>New order</h3>
      <p>Create an order without any network request.</p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          onSave();
        }}
      >
        <label>
          Customer
          <input aria-label="Customer" defaultValue="Ada Lovelace" />
        </label>
        <label>
          Amount
          <input aria-label="Amount" defaultValue="128.00" />
        </label>
        <div>
          <button type="submit">Save order</button>
          <button type="button" className="prototype-page__secondary" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </form>
      {saved ? (
        <aside className="prototype-runtime__overlay" aria-label="Order saved overlay">
          <strong>Order saved</strong>
          <button type="button" onClick={onDismiss}>
            Dismiss
          </button>
        </aside>
      ) : null}
    </article>
  );
}
import { ordersPrototypeFixture } from './orders-prototype-fixtures';
