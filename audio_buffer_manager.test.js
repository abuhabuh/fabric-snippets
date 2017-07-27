/**
 * Unit test for AudioBufferManager
 */

// common testing infrastructure mocha-sinon-chai
require('static/js/test_utils/test_dom')('<html><body></body></html>');
var assert = require('assert');
var sinon = require('sinon');
var chai = require('chai');
var sinonChai = require('sinon-chai');
var expect = chai.expect;
chai.use(sinonChai);


describe('AudioBufferManager', function() {

  describe('get', function() {

    it('returns null if not present', function() {
      // todo - importing abm errors because AudioContext not defined
    });

  });

});