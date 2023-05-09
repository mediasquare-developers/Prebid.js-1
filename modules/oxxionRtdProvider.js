import { submodule } from '../src/hook.js'
import { deepAccess, logInfo, logError } from '../src/utils.js'
import MD5 from 'crypto-js/md5.js';
import { ajax } from '../src/ajax.js';

const oxxionRtdSearchFor = [ 'adUnitCode', 'auctionId', 'bidder', 'bidderCode', 'bidId', 'cpm', 'creativeId', 'currency', 'width', 'height', 'mediaType', 'netRevenue', 'originalCpm', 'originalCurrency', 'requestId', 'size', 'source', 'status', 'timeToRespond', 'transactionId', 'ttl', 'sizes', 'mediaTypes', 'src', 'userId', 'labelAny', 'adId' ];
const LOG_PREFIX = 'oxxionRtdProvider submodule: ';

const allAdUnits = [];

/** @type {RtdSubmodule} */
export const oxxionSubmodule = {
  name: 'oxxionRtd',
  init: init,
  onAuctionEndEvent: onAuctionEnd,
  getBidRequestData: getAdUnits,
};

function init(config, userConsent) {
  if (!config.params || !config.params.domain || !config.params.contexts || !Array.isArray(config.params.contexts) || config.params.contexts.length == 0) {
    return false
  }
  return true;
}

function getAdUnits(reqBidsConfigObj, callback, config, userConsent) {
  if (config.params.threshold && config.params.samplingRate) {
    logInfo(LOG_PREFIX, 'getBidRequestData()', {
      reqBidsConfigObj,
      config,
      userConsent
    });
    let count = 0;
    const requests = reqBidsConfigObj.adUnits.flatMap(({
      bids = [],
      mediaTypes = {},
      code = ''
    }) => bids.reduce((acc, { bidder = '', params = {} }, index) => {
      const id = count++;
      bids[index]._id = id;
      return acc.concat({
        id,
        adUnit: code,
        bidder,
        mediaTypes,
        params: MD5(JSON.stringify(params)).toString()
      });
    }, []));
    const gdpr = userConsent.gdpr.consentString;
    const payload = {
      gdpr,
      requests
    };
    const endpoint = 'https://' + config.params.domain + '.oxxion.io/analytics/bid_rate_interests';
    logInfo(LOG_PREFIX, 'getBidRequestData()', JSON.parse(JSON.stringify(payload)), endpoint);
    getPromisifiedAjax(endpoint, JSON.stringify(payload), {
      method: 'POST',
      withCredentials: true
    }).then(bidsRateInterests => {
      reqBidsConfigObj.adUnits = bidsRateInterests.length
        ? getFilteredAdUnitsOnBidRates(bidsRateInterests, reqBidsConfigObj.adUnits, config.params)
        : reqBidsConfigObj.adUnits;
      logInfo(LOG_PREFIX, 'getBidRequestData() adUnits', JSON.parse(JSON.stringify(reqBidsConfigObj.adUnits)));
      if (typeof callback == 'function') { callback(); }
    }).catch(error => logError(LOG_PREFIX, 'bidInterestError', error));
  }
  if (config.params.contexts && Array.isArray(config.params.contexts) && config.params.contexts.length > 0) {
    const reqAdUnits = reqBidsConfigObj.adUnits;
    if (Array.isArray(reqAdUnits)) {
      reqAdUnits.forEach(adunit => {
        if (config.params.contexts.includes(deepAccess(adunit, 'mediaTypes.video.context'))) {
          allAdUnits.push(adunit);
        }
      });
    }
    if (!(config.params.threshold && config.params.samplingRate) && typeof callback == 'function') {
      callback(); 
    }

  }
}

function insertVideoTracking(bidResponse, config, maxCpm) {
  if (bidResponse.mediaType === 'video') {
    const trackingUrl = getImpUrl(config, bidResponse, maxCpm);
    if (!trackingUrl) {
      return;
    }
    // Vast Impression URL
    if (bidResponse.vastUrl) {
      bidResponse.vastImpUrl = bidResponse.vastImpUrl
        ? trackingUrl + '&url=' + encodeURI(bidResponse.vastImpUrl)
        : trackingUrl
    }
    // Vast XML document
    if (bidResponse.vastXml !== undefined) {
      const doc = new DOMParser().parseFromString(bidResponse.vastXml, 'text/xml');
      const wrappers = doc.querySelectorAll('VAST Ad Wrapper, VAST Ad InLine');
      let hasAltered = false;
      if (wrappers.length) {
        wrappers.forEach(wrapper => {
          const impression = doc.createElement('Impression');
          impression.appendChild(doc.createCDATASection(trackingUrl));
          wrapper.appendChild(impression)
        });
        bidResponse.vastXml = new XMLSerializer().serializeToString(doc);
        hasAltered = true;
      }
      if (hasAltered) {
        logInfo(LOG_PREFIX + 'insert into vastXml for adId ' + bidResponse.adId);
      }
    }
  }
}

function getImpUrl(config, data, maxCpm) {
  const adUnitCode = data.adUnitCode;
  const adUnits = allAdUnits.find(adunit => adunit.code === adUnitCode &&
  'mediaTypes' in adunit &&
  'video' in adunit.mediaTypes &&
  typeof adunit.mediaTypes.video.context === 'string');
  const context = adUnits !== undefined
    ? adUnits.mediaTypes.video.context
    : 'unknown';
  if (!config.params.contexts.includes(context)) {
    return false;
  }
  let trackingImpUrl = 'https://' + config.params.domain + '.oxxion.io/analytics/vast_imp?';
  trackingImpUrl += oxxionRtdSearchFor.reduce((acc, param) => {
    switch (typeof data[param]) {
      case 'string':
      case 'number':
        acc += param + '=' + data[param] + '&'
        break;
    }
    return acc;
  }, '');
  const cpmIncrement = Math.round(100000 * (data.cpm - maxCpm)) / 100000;
  return trackingImpUrl + 'cpmIncrement=' + cpmIncrement + '&context=' + context;
}

function onAuctionEnd(auctionDetails, config, userConsent) {
  const transactionsToCheck = {}
  auctionDetails.adUnits.forEach(adunit => {
    if (config.params.contexts.includes(deepAccess(adunit, 'mediaTypes.video.context'))) {
      transactionsToCheck[adunit.transactionId] = {'bids': {}, 'maxCpm': 0.0, 'secondMaxCpm': 0.0};
    }
  });
  for (const key in auctionDetails.bidsReceived) {
    if (auctionDetails.bidsReceived[key].transactionId in transactionsToCheck) {
      transactionsToCheck[auctionDetails.bidsReceived[key].transactionId]['bids'][auctionDetails.bidsReceived[key].adId] = {'key': key, 'cpm': auctionDetails.bidsReceived[key].cpm};
      if (auctionDetails.bidsReceived[key].cpm > transactionsToCheck[auctionDetails.bidsReceived[key].transactionId]['maxCpm']) {
        transactionsToCheck[auctionDetails.bidsReceived[key].transactionId]['secondMaxCpm'] = transactionsToCheck[auctionDetails.bidsReceived[key].transactionId]['maxCpm'];
        transactionsToCheck[auctionDetails.bidsReceived[key].transactionId]['maxCpm'] = auctionDetails.bidsReceived[key].cpm;
      } else if (auctionDetails.bidsReceived[key].cpm > transactionsToCheck[auctionDetails.bidsReceived[key].transactionId]['secondMaxCpm']) {
        transactionsToCheck[auctionDetails.bidsReceived[key].transactionId]['secondMaxCpm'] = auctionDetails.bidsReceived[key].cpm;
      }
    }
  };
  Object.keys(transactionsToCheck).forEach(transaction => {
    Object.keys(transactionsToCheck[transaction]['bids']).forEach(bid => {
      insertVideoTracking(auctionDetails.bidsReceived[transactionsToCheck[transaction]['bids'][bid].key], config, transactionsToCheck[transaction].secondMaxCpm);
    });
  });
}

/**
 * Promisified an ajax call
 *
 * @param {String} url The targeting URL to call
 * @param {*} [data={}] Payload to pass into the request body
 * @param {Object} [options={}] Xhr options
 * @returns {Promise} A promisified ajax
 */
function getPromisifiedAjax (url, data = {}, options = {}) {
  return new Promise((resolve, reject) => {
    const callbacks = {
      success(responseText, { response }) {
        resolve(JSON.parse(response));
      },
      error(error) {
        reject(error);
      }
    };
    ajax(url, callbacks, data, options);
  })
}

/**
 * Filter bids and adUnits against interesting bids rates.
 *
 * @param {Array} bidsRateInterests Bids rates interests
 * @param {Object} adUnits Object containing auction details
 * @param {Object} params Module configuration parameters
 * @returns {Array} Filtered adUnits
 */
function getFilteredAdUnitsOnBidRates (bidsRateInterests, adUnits, params) {
  const { threshold, samplingRate } = params;
  // Separate bidsRateInterests in two groups against threshold & samplingRate
  const { interestingBidsRates, uninterestingBidsRates } = bidsRateInterests.reduce((acc, interestingBid) => {
    const isBidRateUpper = interestingBid.rate === true || interestingBid.rate > threshold;
    const isBidInteresting = isBidRateUpper || getRandomNumber(100) > samplingRate;
    const key = isBidInteresting ? 'interestingBidsRates' : 'uninterestingBidsRates';
    acc[key].push(interestingBid);
    return acc;
  }, {
    interestingBidsRates: [],
    uninterestingBidsRates: [] // Do something with later
  });
  logInfo(LOG_PREFIX, 'getFilteredAdUnitsOnBidRates()', interestingBidsRates, uninterestingBidsRates);
  // Filter bids and adUnits against interesting bids rates
  return adUnits.filter(({ bids = [] }, adUnitIndex) => {
    adUnits[adUnitIndex].bids = bids.filter(bid => {
      const index = interestingBidsRates.findIndex(({ id }) => id === bid._id);
      delete bid._id;
      return index !== -1;
    });
    return !!adUnits[adUnitIndex].bids.length;
  });
}

/**
 * Get a random number
 *
 * @param {Number} [max=10] Maximum reachable number
 * @returns {Number} A random number
 */
function getRandomNumber (max = 10) {
  return Math.round(Math.random() * max);
}

submodule('realTimeData', oxxionSubmodule);
