define([
  'app',
  'backbone',
  'core/directus',
  "core/EntriesManager"
],

function(app, Backbone, Directus, EntriesManager) {

  return Backbone.Layout.extend({
    template: Handlebars.compile('<span class="big-label-text">Translation:</span><span id="saveTranslateBtn" class="btn">Apply Changes</span> \
      <select id="activeLanguageSelect">{{#languages}}<option {{#if active}}selected{{/if}} value="{{val}}">{{name}}</option>{{/languages}}</select> \
      <div id="translateEditFormEntry"></div>'),
    events: {
      'change #activeLanguageSelect': function(e) {
        this.initializeTranslateView($(e.target).val());
      },
      'click #saveTranslateBtn': function(e) {
        this.translateModel.set(this.translateModel.diff(this.editView.data()));
        if(!this.translateCollection.contains(this.translateModel)) {
          this.translateCollection.add(this.translateModel, {nest: true});
        }
      }
    },
    afterRender: function() {
      if(this.editView) {
        this.insertView("#translateEditFormEntry", this.editView);
        this.editView.render();
      }
    },
    initialize: function(options) {
      this.listenToOnce(this.model, 'sync', this.updateTranslateConnection);
      this.translateId = options.translateId;
      this.translateSettings = options.translateSettings;
    },

    updateTranslateConnection: function() {
      this.translateCollection = this.model.get(this.translateId);

      this.languageCollection = EntriesManager.getInstance(this.translateSettings.languages_table);
      this.listenTo(this.languageCollection, 'sync', function() {this.initializeTranslateView();});
      this.languageCollection.fetch();
    },

    initializeTranslateView: function(language) {
      if(language === undefined) {
        this.activeLanguageId = this.translateSettings.default_language_id;
      } else {
        this.activeLanguageId = language;
      }

      var that = this;
      this.translateModel = null;

      this.translateCollection.forEach(function(model) {
        if(model.get(that.translateSettings.left_column_name) == that.activeLanguageId) {
          that.translateModel = model;
        }
      });

      if(!this.translateModel) {
        this.translateModel = new this.translateCollection.model({}, {collection: this.translateCollection, parse: true});
        var data = {};
        data[this.translateSettings.left_column_name] = this.activeLanguageId;
        data[this.translateSettings.right_column_name] = this.model.id;
        this.translateModel.set(data);
      }

      this.editView = new Directus.EditView({
        model: this.translateModel,
        hiddenFields: [this.translateSettings.left_column_name, this.translateSettings.right_column_name],
      });

      this.render();
    },
    serialize: function() {
      var data = {};

      var that = this;

      if(this.languageCollection) {
        data.languages = this.languageCollection.map(function(item) {
          return {val: item.id, name: item.get(that.translateSettings.languages_name_column), active: (item.id == that.activeLanguageId)};
        });
      }

      return data;
    }
  });
});