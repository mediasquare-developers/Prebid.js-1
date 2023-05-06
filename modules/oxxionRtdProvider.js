import { submodule } from '../src/hook.js'
import { deepAccess, logInfo } from '../src/utils.js'
import MD5 from 'crypto-js/md5.js';
// import { ajax } from '../src/ajax.js';

const oxxionRtdSearchFor = [ 'adUnitCode', 'auctionId', 'bidder', 'bidderCode', 'bidId', 'cpm', 'creativeId', 'currency', 'width', 'height', 'mediaType', 'netRevenue', 'originalCpm', 'originalCurrency', 'requestId', 'size', 'source', 'status', 'timeToRespond', 'transactionId', 'ttl', 'sizes', 'mediaTypes', 'src', 'userId', 'labelAny', 'adId' ];
const LOG_PREFIX = 'oxxionRtdProvider submodule: ';
const allAdUnits = [];
// const INTERESTS_MOCK = [
//   {
//     id: 0,
//     rate: 0.014
//   },
//   {
//     id: 1,
//     rate: 0.9
//   },
//   {
//     id: 2,
//     rate: 1.0
//   }
// ];

/** @type {RtdSubmodule} */
export const oxxionSubmodule = {
  name: 'oxxionRtd',
  init: init,
  onAuctionInitEvent: onAuctionInit,
  onAuctionEndEvent: onAuctionEnd,
  getBidRequestData: getAdUnits,
  getRequestsList: getRequestsList,
  getFilteredBidderRequestsOnBidRates: getFilteredBidderRequestsOnBidRates,
};

function init(config, userConsent) {
  logInfo(LOG_PREFIX, 'init()', config, userConsent);
  if (!config.params || !config.params.domain || !config.params.contexts || !Array.isArray(config.params.contexts) || config.params.contexts.length == 0) {
    return false
  }
  return true;
}

function getAdUnits(reqBidsConfigObj, callback, config, userConsent) {
  const reqAdUnits = reqBidsConfigObj.adUnits;
  if (Array.isArray(reqAdUnits)) {
    reqAdUnits.forEach(adunit => {
      if (config.params.contexts.includes(deepAccess(adunit, 'mediaTypes.video.context'))) {
        allAdUnits.push(adunit);
      }
    });
  }
}

function getRequestsList(bidderRequests) {
  let count = 0;
  return bidderRequests.flatMap(({
    bids = [],
    bidderCode = ''
  }) => {
    return bids.reduce((acc, {adUnitCode = '', params = {}, bidder = '', mediaTypes = {}}, index) => {
      const id = count++;
      bids[index].oxxionId = id;
      return acc.concat({
        id,
        adUnit: adUnitCode,
        bidder,
        mediaTypes,
        params: MD5(JSON.stringify(params)).toString()
      });
    }, []);
  });
}

/**
 * Inspect and/or update the auction on AUCTION_INIT event.
 * Check all bids and their level of interest.
 *
 * @param {Object} auctionDetails
 * @param {Object} config
 * @param {Object} userConsent
 */
function onAuctionInit (auctionDetails, config, userConsent) {
  logInfo(LOG_PREFIX, 'onAuctionInit()', {
    auctionDetails,
    config,
    userConsent
  });
  // TODO: Do we must make an adUnits copy in order to avoid intermediate mutation?
  const gdpr = userConsent.gdpr.consentString;
  if (auctionDetails.bidderRequests) {
    const requests = getRequestsList(auctionDetails.bidderRequests);
    const payload = {
      gdpr,
      requests
    };
    const endpoint = 'https://' + config.params.domain + '.oxxion.io/analytics/bid_rate_interests';
    logInfo(LOG_PREFIX, 'onAuctionInit()', payload, endpoint);

    var xhr = new XMLHttpRequest();
    xhr.onreadystatechange = () => {
      if (xhr.readyState === 4) {
        auctionDetails.bidderRequests = getFilteredBidderRequestsOnBidRates(JSON.parse(xhr.response), auctionDetails.bidderRequests, config.params);
        logInfo(LOG_PREFIX, 'onAuctionInit() bidderRequests', auctionDetails.bidderRequests);
      }
    };
    xhr.open('POST', endpoint, false);
    xhr.withCredentials = true;
    xhr.setRequestHeader('Content-Type', 'application/json;');
    xhr.setRequestHeader('X-Requested-With', 'XMLHttpRequest');
    xhr.setRequestHeader('Access-Control-Allow-Origin', '*');
    xhr.send(JSON.stringify(payload));
    /* getPromisifiedAjax(endpoint, JSON.stringify(payload), {
      method: 'POST',
      // contentType: 'application/json',
      withCredentials: true
    })
    // getPromisifiedAjaxMocked()
      .then(bidsRateInterests => {
        auctionDetails.bidderRequests = getFilteredBidderRequestsOnBidRates(bidsRateInterests, auctionDetails.bidderRequests, config.params);
        logInfo(LOG_PREFIX, 'onAuctionInit() bidderRequests', auctionDetails.bidderRequests);
        return bidsRateInterests;
      })
      .catch(error => logError(LOG_PREFIX, 'bidInterestError', error)); */
  }
}

function getFilteredBidderRequestsOnBidRates(bidsRateInterests, bidders, params, force = false) {
  const { threshold, samplingRate } = params;
  const interstingBidsId = bidsRateInterests.reduce((acc, current) => {
    if (current.suggestion || current.rate > threshold) { acc.push(current.id) }
    return acc
  }, []);
  let newBidders = [];
  bidders.forEach(bidder => {
    var newBidder = JSON.parse(JSON.stringify(bidder))
    newBidder.bids = []
    bidder.bids.forEach(bid => {
      if (interstingBidsId.includes(bid.oxxionId) || (!force && getRandomNumber(100) > samplingRate)) { newBidder.bids.push(bid) }
    });
    if (newBidder.bids.length > 0) { newBidders.push(newBidder) }
  });
  return newBidders;
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
/*
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
} */

// function getPromisifiedAjaxMocked (time = 50) {
//   return new Promise(resolve => setTimeout(() => resolve(INTERESTS_MOCK), time));
// }

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
