import * as moment from 'moment';
import { BillingInfo, BillingType, Date as ProtoDate, GroupData, Transaction, TransactionData } from "../../proto/model";
import { momentToProtoDate, moneyToNumber, protoDateToMoment, timestampToMoment, timestampToWholeSeconds } from "../core/proto-util";
import { maxBy, pushDeduplicate, removeByValue } from '../core/util';
import { DataService } from './data.service';

/** Type guard to check if a transaction has dataType 'single'. */
export function isSingle(transaction: Transaction)
  : transaction is Transaction & { single: TransactionData } {
  return transaction.dataType === 'single';
}

/** Type guard to check if a transaction has dataType 'group'. */
export function isGroup(transaction: Transaction)
  : transaction is Transaction & { group: GroupData } {
  return transaction.dataType === 'group';
}

/**
 * Extracts all TransactionData from one or multiple transactions,
 * no matter if they are of type single or group.
 */
export function extractTransactionData(subject: Transaction | Transaction[]): TransactionData[] {
  if (subject instanceof Transaction) {
    if (isSingle(subject)) {
      return [subject.single!];
    } else {
      return subject.group!.children;
    }
  } else {
    return Array.prototype.concat(
      ...subject.map(transaction => extractTransactionData(transaction))
    );
  }
}

/**
 * Applies a function to all TransactionData contained in one or multiple
 * transactions, no matter if they are of type single or group.
 */
export function forEachTransactionData(
  subject: Transaction | Transaction[],
  callback: (data: TransactionData) => any,
  thisArg?: any
) {
  if (subject instanceof Transaction) {
    if (isSingle(subject)) {
      callback.apply(thisArg, [subject.single]);
    } else {
      subject.group!.children.forEach(callback, thisArg);
    }
  } else {
    for (const transaction of subject) {
      forEachTransactionData(transaction, callback, thisArg);
    }
  }
}

/**
 * Maps all TransactionData contained in one or multiple transactions to
 * a target, no matter if they are of type single or group.
 */
export function mapTransactionData<R>(
  subject: Transaction | Transaction[],
  mapper: (data: TransactionData, index: number, array: TransactionData[]) => R
): R[] {
  if (subject instanceof Transaction) {
    if (isSingle(subject)) {
      return [mapper(subject.single, 0, [subject.single])];
    } else {
      return subject.group!.children.map(mapper);
    }
  } else {
    return Array.prototype.concat(
      ...subject.map(transaction => mapTransactionData(transaction, mapper))
    );
  }
}

/**
 * Returns the values of a specific data field of all TransactionData contained
 * in one or multiple transactions, no matter if they are of type single or group.
 */
export function mapTransactionDataField<K extends keyof TransactionData>(
  subject: Transaction | Transaction[],
  dataField: K
): TransactionData[K][] {
  return mapTransactionData(subject, data => data[dataField]);
}


/**
 * Returns the combined amount of a transaction (the sum of its children).
 */
export function getTransactionAmount(transaction: Transaction): number {
  return mapTransactionData(transaction, data => moneyToNumber(data.amount))
    .reduce((a, b) => a + b, 0);
}

/** Returns an unordered list of all labels that occur in any of the given transactions. */
export function extractAllLabels(transactions: Transaction[]): string[] {
  return Array.from(extractAllLabelsSet(transactions));
}

/** Returns the set of all labels that occur in any of the given transactions. */
export function extractAllLabelsSet(transactions: Transaction[]): Set<string> {
  const labels = new Set<string>();
  for (const transaction of transactions) {
    for (const label of transaction.labels) {
      labels.add(label);
    }
  }
  return labels;
}

/**
 * Adds a label to a transaction after sanitizing it and checking for duplicates.
 * @returns true if the label was added, false if it already existed
 */
export function addLabelToTransaction(transaction: Transaction, label: string): boolean {
  label = label.toLowerCase();
  return pushDeduplicate(transaction.labels, label);
}

/**
 * Removes a label from a transaction if it exists (after sanitizing it).
 * @returns true if the label was removed, false if it was not found
 */
export function removeLabelFromTransaction(transaction: Transaction, label: string): boolean {
  label = label.toLowerCase();
  return removeByValue(transaction.labels, label);
}

/**
 * Returns an ordered list of labels of a transaction that are dominant with
 * respect to a given partial order. The list may be empty.
 */
export function getTransactionDominantLabels(
  transaction: Transaction,
  labelDominanceOrder: { [label: string]: number },
  excludedLabels: string[] = []
): string[] {
  // Fast path for simple cases.
  if (transaction.labels.length <= 1 && excludedLabels.length === 0) {
    return transaction.labels;
  }
  // Get applicable labels ranked by their dominance in descending order.
  // Equally dominant labels are sorted in alphabetical order.
  const labelInfos = transaction.labels
    .filter(label => excludedLabels.indexOf(label) === -1)
    .map(label => ({ label, dominance: labelDominanceOrder[label] || 0 }))
    .sort((a, b) => (b.dominance - a.dominance) || a.label.localeCompare(b.label));

  return labelInfos
    // Only use dominant labels.
    .filter(info => info.dominance === labelInfos[0].dominance)
    .map(info => info.label);
}


// (NOTE: Maybe this should be simplified to an independent interface that exposes moments and not dates.)
export type CanonicalBillingInfo = BillingInfo & { isRelative: false, date: Date, endDate: Date };

/**
 * Returns the canonical billing info that applies to a transaction by resolving
 * inheritance from labels according to the given partial order.
 */
export function resolveTransactionCanonicalBilling(
  transaction: Transaction,
  dataService: DataService,
  labelDominanceOrder: { [label: string]: number }
): CanonicalBillingInfo {
  // Get reference date.
  const dateMoment = timestampToMoment(isSingle(transaction)
    ? transaction.single.date
    : maxBy(transaction.group!.children, child => timestampToWholeSeconds(child.date))!.date
  );

  const rawBilling = resolveTransactionRawBilling(transaction, dataService, labelDominanceOrder);
  return getCanonicalBilling(rawBilling, dateMoment);
}

/**
 * Returns the NOT canonicalized billing info that applies to a transaction by
 * resolving inheritance from labels according to the given partial order.
 */
export function resolveTransactionRawBilling(
  transaction: Transaction,
  dataService: DataService,
  labelDominanceOrder: { [label: string]: number }
): BillingInfo {
  // Initially assume unknown (default) billing.
  let resolvedBilling = new BillingInfo({ periodType: BillingType.UNKNOWN });

  // Check for individual billing config (overrides that inherited from labels).
  if (transaction.billing && transaction.billing.periodType !== BillingType.UNKNOWN) {
    resolvedBilling = transaction.billing;
  } else {
    // Check for billing config inherited from labels.
    // Of the dominant labels, the first present billing config will be applied
    // and the rest ignored.
    const dominantLabels = getTransactionDominantLabels(transaction, labelDominanceOrder);
    for (const label of dominantLabels) {
      const labelConfig = dataService.getLabelConfig(label);
      if (labelConfig && labelConfig.billing && labelConfig.billing.periodType !== BillingType.UNKNOWN) {
        resolvedBilling = labelConfig.billing;
        break;
      }
    }
  }

  return resolvedBilling;
}

/**
 * Returns the canonical form of a BillingInfo object:
 * - "periodType" is inferred to DAY if unknown.
 * - "date" is explicitly set and defaults to the reference date.
 * - "endDate" is explicitly set and defaults to the value of "date".
 * - Relative dates are resolved into absolute dates.
 * - All dates are normalized to include the full interval with day granularity.
 *   * periodType == DAY: no normalization necessary
 *   * periodType == MONTH: "date" is 1st day of the month, "endDate" last day of the month.
 *   * periodType == YEAR: "date" is Jan 1st, "endDate" is Dec 31st.
 */
export function getCanonicalBilling(billing: BillingInfo, referenceMoment: moment.Moment): CanonicalBillingInfo {
  const periodType = (billing.periodType === BillingType.UNKNOWN ? BillingType.DAY : billing.periodType);

  // Adjust granularity of reference moment to beginning of period type.
  const normalizedReference = normalizeMomentToPeriodType(referenceMoment, periodType);

  let startMoment = billing.date
    ? (billing.isRelative
      ? computeRelative(normalizedReference, billing.date)
      : protoDateToMoment(billing.date))
    : normalizedReference;
  let endMoment = billing.endDate
    ? (billing.isRelative
      ? computeRelative(normalizedReference, billing.endDate)
      : protoDateToMoment(billing.endDate))
    : startMoment.clone();

  startMoment = normalizeMomentToPeriodType(startMoment, periodType);
  endMoment = normalizeMomentToPeriodType(endMoment, periodType);

  // If necessary, normalize end date to "end of month/year".
  if (periodType === BillingType.YEAR) {
    endMoment.month(11).date(31);
  } else if (periodType === BillingType.MONTH) {
    // endMoment is currently at the 1st of the month.
    endMoment.add(1, 'month').subtract(1, 'day');
  }

  return <CanonicalBillingInfo>new BillingInfo({
    periodType,
    isRelative: false,
    date: momentToProtoDate(startMoment),
    endDate: momentToProtoDate(endMoment),
    isPeriodic: billing.isPeriodic,
  });
}

function normalizeMomentToPeriodType(theMoment: moment.Moment, periodType: BillingType): moment.Moment {
  const normalized = theMoment.clone();
  switch (periodType) {
    case BillingType.YEAR:
      normalized.month(0);
    // fall-through
    case BillingType.MONTH:
      normalized.date(1);
    // fall-through
    case BillingType.DAY:
    case BillingType.NONE:
      normalized.set({ hour: 0, minute: 0, second: 0, millisecond: 0 });
  }
  return normalized;
}

function computeRelative(referenceMoment: moment.Moment, delta: ProtoDate): moment.Moment {
  return referenceMoment.clone()
    .add(delta.year, 'year')
    .add(delta.month, 'month')
    .add(delta.day, 'day');
}
