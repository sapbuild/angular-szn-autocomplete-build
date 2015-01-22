/**
 * AngularJS directive to display suggestions while you type into text input.
 *
 * @author Jiri Kuchta <jiri.kuchta@live.com>
 * @version 0.1.1
 *
 */
(function () {
	"use strict";

	var ngModule = angular.module( "ngSznAutocomplete", ["ngSznAutocomplete/template/shadowinput.html", "ngSznAutocomplete/template/default.html"]);

	var SznAutocompleteLink = function ($q, $timeout, $http, $compile, $templateCache, $scope, $elm, $attrs) {
		this._$q = $q;
		this._$timeout = $timeout;
		this._$http = $http;
		this._$compile = $compile;
		this._$templateCache = $templateCache;
		this._$scope = $scope;
		this._$attrs = $attrs;

		this._$scope.$evalAsync((function ($elm) {

			this._options = this._getOptions();

			// waiting timeout before calling for results ("delay" option)
			this._delayTimeout = null;

			// this is where we store promise when waiting for results
			this._deferredResults = null;

			// isolated scope that will be bound to the results template
			this._resultsScope = this._$scope.$new(true);
			this._resultsScope.show = false;
			this._resultsScope.highlightIndex = -1;

			this._dom = {
				input: $elm,
				resultsCont: null
			};
			this._dom.parent = this._getParentElm();

			this._init();
		}).bind(this, $elm));
	};

	// default configuration
	SznAutocompleteLink.DEFAULT_OPTIONS = {
		templateUrl: "ngSznAutocomplete/template/default.html", // popup template URL
		highlightFirst: false, 									// automatically highlight the first result in the popup?
		shadowInput: false, 									// show the shadowInput?
		onSelect: null, 										// a callback function to call after selection
		searchMethod: "getAutocompleteResults", 				// name of scope method to call to get results
		parentElm: "", 											// CSS selector of element in which the results and shadowInput should be appended into (default is parent element of the main input)
		delay: 100, 											// time in ms to wait before calling for results
		minLength: 1,											// minimal number of character that needs to be entered to search for results
		uniqueId: null,											// this ID will be passed as an argument in every event to easily identify this instance (in case there are multiple instances on the page)
		boldMatches: true										// bold matches in results?
	};

	SznAutocompleteLink.IGNORED_KEYS = [16, 17, 18, 20, 37];

	SznAutocompleteLink.NAVIGATION_KEYS = [13, 27, 9, 38, 39, 40];

	/**
	 * Get the directive configuration.
	 * Options can be set either via element attributes (e.g. szn-autocomplete-delay="500")
	 * or in configuration object whose name is set as value of directive element attribute (e.g. szn-autocomplete="config")
	 * @returns {object} configuration object
	 */
	SznAutocompleteLink.prototype._getOptions = function () {
		var options = {};

		var optionsObject = this._$scope[this._$attrs.sznAutocomplete] || {};

		for (var key in this.constructor.DEFAULT_OPTIONS) {
			var capKey = key.charAt(0).toUpperCase() + key.slice(1);
			// options set via element attributes have highest priority
			options[key] = this._$attrs["sznAutocomplete" + capKey] || optionsObject[key] || this.constructor.DEFAULT_OPTIONS[key];
		}

		if (!this._$scope[options.searchMethod]) {
			throw new Error("ngSznAutocomplete: scope method \"" + options.searchMethod + "\" does not exist.");
		}

		return options;
	};

	/**
	 * Init method
	 * Appends popup and shadowInput elements into DOM, adds event listeners
	 */
	SznAutocompleteLink.prototype._init = function () {
		this._getTemplate()
			.then((function (template) {
				this._dom.resultsCont = angular.element(this._$compile(this._$templateCache.get(this._options.templateUrl))(this._resultsScope));
				this._dom.parent.append(this._dom.resultsCont);

				if (this._options.shadowInput) {
					var shadowInputTemplate = this._$templateCache.get("ngSznAutocomplete/template/shadowinput.html");
					this._dom.shadowInput = angular.element(this._$compile(shadowInputTemplate)(this._resultsScope));
					this._dom.input[0].parentNode.insertBefore(this._dom.shadowInput[0], this._dom.input[0]);
				}
			}).bind(this))
			.then((function () {
				this._dom.input.attr("autocomplete", "off");
				this._dom.input.bind("keyup", this._keyup.bind(this));
				this._dom.input.bind("keypress", this._keypress.bind(this));
				this._dom.input.bind("blur", (function () {
					// in case we click on some result the blur event is fired
					// before the result can be selected. So we have to wait a little.
					this._$timeout(this._hide.bind(this, true), 200);
				}).bind(this));

				// we need some methods and variables to be accessible within isolated popup scope
				this._resultsScope.highlight = this._highlight.bind(this);
				this._resultsScope.select = this._select.bind(this);
				this._resultsScope.boldMatches = this._options.boldMatches;

				this._$scope.$emit("ngSznAutocomplete-init", {instanceId: this._options.uniqueId});
			}).bind(this));
	};

	/**
	 * Handles keyup event
	 * Calls for suggestions if every condition is met.
	 * @param {object} event
	 */
	SznAutocompleteLink.prototype._keyup = function (e) {
		if (this.constructor.IGNORED_KEYS.indexOf(e.keyCode) == -1) {
			if (this.constructor.NAVIGATION_KEYS.indexOf(e.keyCode) == -1) {
				var query = e.target.value;
				if (query.length >= this._options.minLength) {

					// cancel previous timeout
					if (this._delayTimeout) {
						this._$timeout.cancel(this._delayTimeout);
					}

					this._delayTimeout = this._$timeout((function () {
						this._getResults(query);
					}).bind(this), this._options.delay);
				} else {
					// not enough number of characters
					this._hide(true);
				}
			}
		}
	};

	/**
	 * Handles keypress event
	 * @param {object} event
	 */
	SznAutocompleteLink.prototype._keypress = function (e) {
		if (this.constructor.IGNORED_KEYS.indexOf(e.keyCode) == -1) {
			if (this.constructor.NAVIGATION_KEYS.indexOf(e.keyCode) != -1) {
				this._navigate(e);
			}
		}
	};

	/**
	 * Calls for results
	 * @param {string} query
	 */
	SznAutocompleteLink.prototype._getResults = function (query) {
		// "loading" scope variable can be used to show loading indicator
		this._resultsScope.loading = true;

		this._deferredResults = this._$q.defer();
		this._deferredResults.promise.then(
			(function (query, data) {

				// there is nothing to show
				if (!data.results || !data.results.length) {
					this._hide();
					return;
				}

				// all returned data are available in the popup scope
				for (var key in data) {
					this._resultsScope[key] = data[key];
				}

				this._show();

				if (this._options.highlightFirst) {
					this._highlight(0);
				}

				this._resultsScope.query = this._$scope[this._$attrs["ngModel"]];
				this._resultsScope.shadowInputValue = "";

				if (data.results[0].value.substring(0, query.length).toLowerCase() == query.toLowerCase()) {
					this._resultsScope.shadowInputValue = data.results[0].value;
				}

				this._resultsScope.loading = false;
			}).bind(this, query),
			(function () {
				this._hide(true);
			}).bind(this)
		);

		this._$scope[this._options.searchMethod](query, this._deferredResults);
	};

	/**
	 * Show the popup
	 */
	SznAutocompleteLink.prototype._show = function () {
		if (!this._resultsScope.show) {
			this._resultsScope.show = true;
			this._$scope.$emit("ngSznAutocomplete-show", {instanceId: this._options.uniqueId});
		}
	};

	/**
	 * Hide the popup
	 * @param {bool} digest Trigger $digest cycle?
	 */
	SznAutocompleteLink.prototype._hide = function (digest) {
		if (this._resultsScope.show) {
			if (this._delayTimeout) {
				this._$timeout.cancel(this._delayTimeout);
			}

			if (this._deferredResults) {
				this._deferredResults.reject();
			}

			this._resultsScope.show = false;
			this._resultsScope.loading = true;
			this._resultsScope.highlightIndex = -1;
			this._resultsScope.shadowInputValue = "";

			if (digest) { this._resultsScope.$digest(); }

			this._$scope.$emit("ngSznAutocomplete-hide", {instanceId: this._options.uniqueId});
		}
	};

	/**
	 * Handles navigation keys press
	 * @param {object} event
	 */
	SznAutocompleteLink.prototype._navigate = function (e) {
		if (this._resultsScope.show) {
			switch (e.keyCode) {
				case 27: // ESC
					this._hide(true);
				break;
				case 13: // ENTER
					this._select();
				break;
				case 38: // UP
					this._move(-1);
				break;
				case 40: // DOWN
					this._move(1);
				break;
				case 39: // RIGHT
					this._copyFromShadow();
				break;
				case 9: // TAB
					this._copyFromShadow();
				break;
			};
		}
	};

	/**
	 * Is called after some result is selected.
	 */
	SznAutocompleteLink.prototype._select = function (value) {
		if (value) { this._setValue(value); }

		this._$scope.$emit("ngSznAutocomplete-select", {
			instanceId: this._options.uniqueId,
			value: this._$scope[this._$attrs["ngModel"]]
		});

		this._hide(true);

		if (this._options.onSelect) {
			// call the "onSelect" option callback
			this._$scope[this._options.onSelect]();
		}
	};

	/**
	 * Set the main input value
	 * @param {string} value A string to be set as value. Default is actually highlighted result value.
	 */
	SznAutocompleteLink.prototype._setValue = function (value) {
		if (value) {
			this._$scope[this._$attrs["ngModel"]] = value;
			this._$scope.$digest();
		}
	};

	/**
	 * Highlights a result item
	 * @param {int} index An index of results item to be highlighted
	 * @param {bool} digest Trigger $digest cycle?
	 */
	SznAutocompleteLink.prototype._highlight = function (index, digest) {
		this._resultsScope.highlightIndex = index;
		if (digest) { this._resultsScope.$digest(); }
	};

	/**
	 * Move through the results
	 * @param {int} direction Direction to move ("-1" or "1")
	 */
	SznAutocompleteLink.prototype._move = function (direction) {
		this._resultsScope.shadowInputValue = "";
		var i = this._getMoveIndex(direction);
		this._highlight(i, true);
		this._setValue(this._resultsScope.results[i].value);
	};

	/**
	 * Returns index of next or previous result item
	 * @param {int} direction Direction to move ("-1" or "1")
	 * @return {int} index
	 */
	SznAutocompleteLink.prototype._getMoveIndex = function (direction) {
		var index = this._resultsScope.highlightIndex + direction;
		if (index > this._resultsScope.results.length - 1) {
			index = 0;
		} else if (index < 0) {
			index = this._resultsScope.results.length - 1;
		}

		return index;
	};

	/**
	 * Complete word or append new one from shadowInput to the main input
	 */
	SznAutocompleteLink.prototype._copyFromShadow = function () {
		if (!this._options.shadowInput || !this._resultsScope.shadowInputValue) {
			return;
		}

		var shadowWords = this._resultsScope.shadowInputValue.split(" ");
		var queryWords = this._$scope[this._$attrs["ngModel"]].split(" ");

		var i = queryWords.length - 1;
		if (queryWords[i].length < shadowWords[i].length) { // complete word
			queryWords[i] = shadowWords[i];
		} else if (shadowWords[i + 1]) { // append next word
			queryWords.push(shadowWords[i + 1]);
		} else {
			return;
		}

		// set input value and call for new results
		var query = queryWords.join(" ")
		this._$scope[this._$attrs["ngModel"]] = query;
		this._getResults(query);
	};

	/**
	 * Gets popup template
	 * @return {promise}
	 */
	SznAutocompleteLink.prototype._getTemplate = function () {
		var deferred = this._$q.defer();

		var template = this._$templateCache.get(this._options.templateUrl);
		if (template) {
			deferred.resolve(template);
		} else {
			this._$http.get(this._options.templateUrl)
				.success((function (deferred, data) { deferred.resolve(data); }).bind(this, deferred))
				.error((function (deferred, data) { throw new Error("ngSznAutocomplete: Failed to load template \"" + this._options.templateUrl + "\".") }));
		}

		return deferred.promise;
	};

	/**
	 * Finds and returns parent element to append popup and shadowInput elements into
	 * @return {ngElement}
	 */
	SznAutocompleteLink.prototype._getParentElm = function () {
		if (this._options.parentElm) {
			var parent = document.querySelector(this._options.parentElm);
			if (!parent) {
				throw new Error("ngSznAutocomplete: CSS selector \"" + this._options.parentElm + "\" does not match any element.");
			}
			return angular.element(parent);
		} else {
			return this._dom.input.parent();
		}
	};

	ngModule.directive("sznAutocomplete", ["$q", "$timeout", "$http", "$compile", "$templateCache", function ($q, $timeout, $http, $compile, $templateCache) {
		return {
			restrict: "AC",
			require: 'ngModel',
			link: function ($scope, $elm, $attrs) {
				return new SznAutocompleteLink($q, $timeout, $http, $compile, $templateCache, $scope, $elm, $attrs);
			}
		};
	}]);

	/**
	 * A special directive for each item in results.
	 */
	ngModule.directive("sznAutocompleteResult", [function () {
		return {
			link: function ($scope, $elm, $attrs) {
				$elm.on("mousemove", (function () {
					// the cursor is over the element -> highlight
					if ($scope.highlightIndex != $scope.$index) {
						$scope.highlight($scope.$index, true);
					}
				}).bind(this));
				$elm.on("mouseout", (function () {
					// the cursor left -> cancel highlight
					if ($scope.highlightIndex != $scope.$index) {
						$scope.highlight(-1, true);
					}
				}).bind(this));
				$elm.on("click", (function () {
					// select this result
					$scope.select($scope.results[$scope.$index].value);
				}).bind(this));
			}
		};
	}]);

	/**
	 * Custom bind-html directive, so we dont have to include whole "angular-sanitize" module
	 */
	ngModule.directive("viewAsHtml", function () {
		return function ($scope, $elm, $attrs) {
			$elm.addClass('ng-binding').data('$binding', $attrs.viewAsHtml);
			$scope.$watch($attrs.viewAsHtml, function bindHtmlWatchAction(value) {
				$elm.html(value || '');
			});
		};
	});

	/**
	 * Filter to bold searched query matches in results
	 */
	ngModule.filter("sznAutocompleteBoldMatch", function() {
		return function(matchItem, query) {
			var i = matchItem.toLowerCase().indexOf(query.toLowerCase());
			if (i < 0) {
				return matchItem;
			}

			var parts = [];
			parts.push("<b>" + matchItem.substring(0, i) + "</b>");
			parts.push(matchItem.substring(i, i + query.length));
			parts.push("<b>" + matchItem.substring(i + query.length) + "</b>");

			return parts.join("");
		};
	 });

	/**
	 * Shadow input template
	 */
	angular.module("ngSznAutocomplete/template/shadowinput.html", []).run(["$templateCache", function($templateCache) {
		$templateCache.put("ngSznAutocomplete/template/shadowinput.html",
			'<input type="text" class="szn-autocomplete-shadow-input" ng-value="shadowInputValue" disabled="disabled">'
		);
	}]);

	/**
	 * Default popup template
	 */
	angular.module("ngSznAutocomplete/template/default.html", []).run(["$templateCache", function($templateCache) {
		$templateCache.put("ngSznAutocomplete/template/default.html",
			'<ul ng-show="show" class="szn-autocomplete-results" ng-class="{loading: loading}">\n' +
				'<li szn-autocomplete-result ng-repeat="result in results" ng-class="{selected: highlightIndex == $index}">\n' +
					'<span ng-if="boldMatches" view-as-html="result.value | sznAutocompleteBoldMatch:query"></span>\n' +
					'<span ng-if="!boldMatches">{{result.value}}</span>\n' +
				'</li>\n' +
			'</ul>'
		);
	}]);

})();
