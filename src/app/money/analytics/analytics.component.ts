import { Component, OnDestroy, OnInit } from '@angular/core';
import { Router } from '@angular/router';
import * as moment from 'moment';
import { BehaviorSubject, combineLatest, Subscription } from 'rxjs';
import { map, tap } from 'rxjs/operators';
import { LoggerService } from 'src/app/core/logger.service';
import { escapeRegex, splitQuotedString } from 'src/app/core/util';
import { BillingInfo, BillingType, Transaction, TransactionData } from '../../../proto/model';
import { KeyedArrayAggregate, KeyedNumberAggregate } from '../../core/keyed-aggregate';
import { momentToProtoDate, protoDateToMoment } from '../../core/proto-util';
import { DataService } from '../data.service';
import { DialogService } from '../dialog.service';
import { FilterState } from '../filter-input/filter-state';
import { CanonicalBillingInfo, extractAllLabels, getTransactionAmount, mapTransactionData, resolveTransactionCanonicalBilling } from '../model-util';
import { TransactionFilterService } from '../transaction-filter.service';
import { LabelDominanceOrder } from './dialog-label-dominance/dialog-label-dominance.component';

/** The character that is used in label names to define a hierarchy. */
export const LABEL_HIERARCHY_SEPARATOR = '/';

@Component({
  selector: 'app-analytics',
  templateUrl: './analytics.component.html',
  styleUrls: ['./analytics.component.css']
})
export class AnalyticsComponent implements OnInit, OnDestroy {
  // TODO Split this component into multiple parts, possibly add "AnalyticsService" for shared functionality.

  private static lastFilterValue = "";

  readonly filterState = new FilterState(AnalyticsComponent.lastFilterValue);
  readonly ignoreBillingPeriodSubject = new BehaviorSubject<boolean>(false);
  readonly labelCollapseSubject = new BehaviorSubject<void>(void (0));
  private readonly labelDominanceSubject = new BehaviorSubject<LabelDominanceOrder>({});

  private static readonly uncollapsedLabels = new Set<string>();
  // TODO: Refactor this into a "LabelGroupService" that abstracts & persists the storage of this.
  labelGroups: LabelGroup[] = [];
  totalTransactionCount = 0;
  matchingTransactionCount = 0;
  hasFilteredPartiallyBilledTransactions = false;

  /**
   * Main output of the transaction preprocessing. Contains filtered transactions
   * billed to and split across their respective date buckets.
   * Subcomponents can further process this dataset.
   */
  billedTransactionBuckets = new KeyedArrayAggregate<BilledTransaction>();

  private matchingTransactions: Transaction[] = [];
  /** The part of the current filter string that performs date filtering. */
  private dateRestrictingFilter: string | null = null;
  private txSubscription: Subscription;

  constructor(
    private readonly dataService: DataService,
    private readonly filterService: TransactionFilterService,
    private readonly dialogService: DialogService,
    private readonly router: Router,
    private readonly loggerService: LoggerService) { }

  ngOnInit() {
    this.dataService.userSettings$
      .pipe(map(settings => settings.labelDominanceOrder))
      .subscribe(this.labelDominanceSubject);

    this.labelCollapseSubject.subscribe(() => this.refreshUncollapsedLabels());

    this.txSubscription =
      combineLatest(
        this.dataService.transactions$,
        this.filterState.value$.pipe(tap(value => AnalyticsComponent.lastFilterValue = value)),
        this.ignoreBillingPeriodSubject,
        this.labelCollapseSubject,
        this.labelDominanceSubject)
        .subscribe(([_, filterValue, ignoreBilling, __, ___]) => this.analyzeTransactions(filterValue, ignoreBilling));
  }

  ngOnDestroy() {
    this.txSubscription.unsubscribe();
  }

  /** Add label(s) to filter or navigate to transactions when clicking on them. */
  onLabelGroupClick(clickedLabels: string[], isAltClick: boolean) {
    // TODO Refactor token operations into some utility method.
    const addedTokens = (clickedLabels.length === 0
      ? ['-label:.']
      : clickedLabels.map(label => (label.endsWith('+')
        ? 'label:^' + escapeRegex(label.substring(0, label.length - 1))
        : 'label=' + label)));
    let filter = this.filterState.getCurrentValue();
    for (const newToken of addedTokens) {
      if (filter.length > 0) {
        if (filter.includes(newToken)) {
          continue; // Don't add duplicate tokens (best effort matching).
        }
        filter += " " + newToken;
      } else {
        filter = newToken;
      }
    }

    if (isAltClick) {
      this.router.navigate(['/transactions'], { queryParams: { q: filter } });
    } else {
      this.filterState.setValueNow(filter);
    }
  }

  /** Add month to filter or navigate to transactions when clicking on it. */
  onChartBucketClick(bucketName: string, isAltClick: boolean) {
    // TODO Refactor token operations into some utility method.
    const addedToken = 'date:' + bucketName;
    let filter = this.filterState.getCurrentValue();
    if (!filter.includes(addedToken)) {
      if (filter.length > 0) {
        filter += " " + addedToken;
      } else {
        filter = addedToken;
      }
    }

    if (isAltClick) {
      this.router.navigate(['/transactions'], { queryParams: { q: filter } });
    } else {
      this.filterState.setValueNow(filter);
    }
  }

  collapseAllGroups() {
    AnalyticsComponent.uncollapsedLabels.clear();
    this.labelGroups.forEach(group => group.shouldCollapse = true);
    // Note: Do not remove void param as compiler will complain even though
    // IDE says it is fine.
    this.labelCollapseSubject.next(void (0));
  }

  uncollapseAllGroups() {
    this.labelGroups.forEach(group => group.shouldCollapse = false);
    this.labelCollapseSubject.next(void (0));
  }

  openLabelDominanceDialog() {
    const originalDominanceOrder = this.labelDominanceSubject.getValue();
    const dominanceOrder = Object.assign({}, originalDominanceOrder);

    this.dialogService.openAnalyticsLabelDominance(dominanceOrder)
      .afterConfirmed().subscribe(() => {
        this.dataService.getUserSettings().labelDominanceOrder = dominanceOrder;
        this.labelDominanceSubject.next(dominanceOrder);
      });
  }

  private refreshUncollapsedLabels() {
    for (const group of this.labelGroups) {
      if (group.shouldCollapse) {
        AnalyticsComponent.uncollapsedLabels.delete(group.parentName);
      } else {
        AnalyticsComponent.uncollapsedLabels.add(group.parentName);
      }
    }
  }

  private analyzeTransactions(filterValue: string, ignoreBilling: boolean) {
    let tStart = performance.now();

    const allTransactions = this.dataService.getCurrentTransactionList();
    const processedFilter = this.preprocessFilter(filterValue, ignoreBilling);
    this.matchingTransactions = this.filterService.applyFilter(allTransactions, processedFilter);
    this.totalTransactionCount = allTransactions.length;
    this.matchingTransactionCount = this.matchingTransactions.length;

    this.analyzeLabelGroups();
    this.analyzeMonthlyBreakdown(ignoreBilling);

    let tEnd = performance.now();
    this.loggerService.debug(`analyzeTransactions: ${tEnd - tStart} ms for ${this.matchingTransactionCount} transactions`);
  }

  /** Replaces 'date' filter tokens with 'billing' tokens and updates this.dateRestrictingFilter accordingly. */
  private preprocessFilter(filterValue: string, ignoreBilling: boolean): string {
    this.dateRestrictingFilter = null;

    if (ignoreBilling) {
      return filterValue;
    }
    // TODO make operating on individual filter tokens nicer :(
    const tokens = splitQuotedString(filterValue);
    const dateTokenRegex = /^(-?)date(:|=|<=?|>=?)/;
    const dateTokens: string[] = [];
    const processed = tokens.map(token => {
      if (dateTokenRegex.test(token)) {
        token = token.replace('date', 'billing');
        dateTokens.push('"' + token + '"');
      }
      return '"' + token + '"';
    }).join(' ');

    if (dateTokens.length > 0) {
      this.dateRestrictingFilter = dateTokens.join(' ');
    }

    return processed;
  }

  /**
   * Computes the list of parent labels that have sublabels and their collapsed
   * state and stores it into this.labelGroups.
   **/
  private analyzeLabelGroups() {
    const labels = extractAllLabels(this.matchingTransactions);
    const parentLabels = new KeyedArrayAggregate<string>();
    for (const label of labels) {
      const sepIndex = label.indexOf(LABEL_HIERARCHY_SEPARATOR);
      if (sepIndex > 0) {
        parentLabels.add(label.substr(0, sepIndex), label.substr(sepIndex + 1));
      } else {
        // Just a regular label, but it may be a parent to some other children.
        parentLabels.add(label, label);
      }
    }

    this.labelGroups = parentLabels.getEntries()
      .filter(entry => entry[1].length > 1)
      .map(entry => <LabelGroup>{
        parentName: entry[0],
        children: entry[1],
        shouldCollapse: !AnalyticsComponent.uncollapsedLabels.has(entry[0]),
      });
  }

  private analyzeMonthlyBreakdown(ignoreBilling: boolean) {
    const displayUnit = 'month';
    const keyFormat = 'YYYY-MM';

    const mainCurrency = this.dataService.getMainCurrency();
    const labelDominanceOrder = this.dataService.getUserSettings().labelDominanceOrder;
    const billedBuckets = new KeyedArrayAggregate<BilledTransaction>();

    const debugContribHistogram = new KeyedNumberAggregate();
    for (const transaction of this.matchingTransactions) {
      let billing: CanonicalBillingInfo;
      if (ignoreBilling) {
        // Hack: To ignore billing, temporarily clear fields of transaction.
        const origValues = { billing: transaction.billing, labels: transaction.labels };
        transaction.billing = null;
        transaction.labels = [];
        try { billing = resolveTransactionCanonicalBilling(transaction, this.dataService, labelDominanceOrder); }
        finally {
          transaction.billing = origValues.billing;
          transaction.labels = origValues.labels;
        }
      }
      else {
        billing = resolveTransactionCanonicalBilling(transaction, this.dataService, labelDominanceOrder);
      }

      // Skip transactions that are excluded from billing.
      if (billing.periodType === BillingType.NONE) {
        continue;
      }

      const fromMoment = protoDateToMoment(billing.date);
      const toMoment = protoDateToMoment(billing.endDate);

      // TODO: Handle "billing.isPeriodic" (currently completely unused).

      const contributingKeys: string[] = [];
      // Iterate over date units and collect their keys.
      // Start with the normalized version of fromMoment (e.g. for months,
      // 2018-05-22 is turned into 2018-05-01).
      const it = moment(fromMoment.format(keyFormat), keyFormat);
      while (it.isSameOrBefore(toMoment)) {
        contributingKeys.push(it.format(keyFormat));
        it.add(1, displayUnit);
      }

      debugContribHistogram.add(contributingKeys.length + "", 1);

      // TODO: Support converting currencies to main currency.
      const currencies = mapTransactionData(transaction, this.dataService.currencyFromTxDataFn);
      if (currencies.some(curr => curr !== mainCurrency)) {
        // Skip for now.
        continue;
      }

      // TODO: For DAY billing granularity, we may want to consider proportional contributions to the months.
      const amountPerBucket = getTransactionAmount(transaction) / contributingKeys.length;
      for (const key of contributingKeys) {
        billedBuckets.add(key, {
          source: transaction,
          amount: amountPerBucket,
        });
      }
    }

    this.loggerService.debug("stats of # of billed months", debugContribHistogram.getEntries());

    // Fill holes in billedBuckets with empty buckets.
    // Sort the keys alphanumerically as the keyFormat is big-endian.
    const sortedKeys = billedBuckets.getKeys().sort();
    if (sortedKeys.length > 1) {
      const last = sortedKeys[sortedKeys.length - 1];
      const it = moment(sortedKeys[0]);
      while (it.isBefore(last)) {
        it.add(1, displayUnit);
        // Make sure each date unit (e.g. month) is represented as a bucket.
        billedBuckets.addMany(it.format(keyFormat), []);
      }
    }

    this.cleanBucketsByDateFilter(billedBuckets);

    this.billedTransactionBuckets = billedBuckets;
  }

  // TODO: This is specialized to MONTH view, make sure to change once other granularities are supported.
  private cleanBucketsByDateFilter(billedBuckets: KeyedArrayAggregate<BilledTransaction>) {
    this.hasFilteredPartiallyBilledTransactions = false;

    if (!this.dateRestrictingFilter) {
      return;
    }
    // Create a fake transaction that is billed during the bucket's month
    // and check if it would pass the date filter.
    const dummyBilling = new BillingInfo({ periodType: BillingType.MONTH });
    const dummyTransactionList = [new Transaction({ billing: dummyBilling, single: new TransactionData() })];
    for (const [key, billedTransactions] of billedBuckets.getEntries()) {
      const keyMoment = moment(key);
      dummyBilling.date = momentToProtoDate(keyMoment);
      const result = this.filterService.applyFilter(dummyTransactionList, this.dateRestrictingFilter);
      if (result.length === 0) {
        // This bucket does not pass the filter.
        billedBuckets.delete(key);
        this.hasFilteredPartiallyBilledTransactions = true;
      }
    }
  }

}

/** Provides data about a label with sublabels (induced label hierarchy). */
export interface LabelGroup {
  parentName: string;
  children: string[];
  shouldCollapse: boolean;
}

/** Contains data about a transcation billed to a specific date bucket. */
export interface BilledTransaction {
  source: Transaction;
  /** Contribution amount of transaction in main currency. */
  amount: number;
}
