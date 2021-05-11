/**
 * This is a "local store" meant to make the field data shareable between the different panes
 * and components within the field setup modal flow.
 *
 * It's reset every time the modal opens and shouldn't be used outside of the field-detail flow.
 */

import { getDisplays } from '@/displays';
import { DisplayConfig } from '@/displays/types';
import { getInterfaces } from '@/interfaces';
import { InterfaceConfig } from '@/interfaces/types';
import { useCollectionsStore, useFieldsStore, useRelationsStore } from '@/stores/';
import { Collection, Field, localTypes, Relation, Item } from '@/types';
import { computed, ComputedRef, reactive, watch, WatchStopHandle } from '@vue/composition-api';
import { clone, throttle } from 'lodash';
import Vue from 'vue';

const fieldsStore = useFieldsStore();
const relationsStore = useRelationsStore();
const collectionsStore = useCollectionsStore();

type GenerationInfo = {
	name: string;
	type: 'collection' | 'field';
};

let state: {
	fieldData: DeepPartial<Field>;
	relations: DeepPartial<Relation>[];
	newCollections: DeepPartial<Collection & { fields?: DeepPartial<Field>[]; $type?: string }>[];
	newFields: DeepPartial<Field & { $type?: string }>[];
	updateFields: DeepPartial<Field>[];
	newRows: Record<string, Item[]>;
	autoFillJunctionRelation: boolean;
};

let availableInterfaces: ComputedRef<InterfaceConfig[]>;
let availableDisplays: ComputedRef<DisplayConfig[]>;
let generationInfo: ComputedRef<GenerationInfo[]>;

export { state, availableInterfaces, availableDisplays, generationInfo, initLocalStore, clearLocalStore };

function initLocalStore(collection: string, field: string, type: typeof localTypes[number]): void {
	const { interfaces } = getInterfaces();
	const { displays } = getDisplays();

	state = reactive({
		fieldData: {
			field: '',
			type: 'string',
			schema: {
				default_value: undefined,
				max_length: undefined,
				is_nullable: true,
				is_unique: false,
				numeric_precision: null,
				numeric_scale: null,
			},
			meta: {
				hidden: false,
				interface: undefined,
				options: undefined,
				display: undefined,
				display_options: undefined,
				readonly: false,
				special: undefined,
				note: undefined,
			},
		},
		relations: [],
		newCollections: [],
		newFields: [],
		updateFields: [],
		newRows: {},

		autoFillJunctionRelation: false,
	});

	availableInterfaces = computed<InterfaceConfig[]>(() => {
		return interfaces.value
			.filter((inter: InterfaceConfig) => {
				// Filter out all system interfaces
				if (inter.system === true) return false;

				const matchesType = inter.types.includes(state.fieldData?.type || 'alias');
				const matchesLocalType = (inter.groups || ['standard']).includes(type);

				return matchesType && matchesLocalType;
			})
			.sort((a: InterfaceConfig, b: InterfaceConfig) => (a.name > b.name ? 1 : -1));
	});

	availableDisplays = computed(() => {
		return displays.value
			.filter((inter: InterfaceConfig) => {
				const matchesType = inter.types.includes(state.fieldData?.type || 'alias');
				const matchesLocalType = (inter.groups || ['standard']).includes(type) || true;

				return matchesType && matchesLocalType;
			})
			.sort((a: InterfaceConfig, b: InterfaceConfig) => (a.name > b.name ? 1 : -1));
	});

	generationInfo = computed(() => {
		return [
			...state.newCollections.map(
				(newCollection): GenerationInfo => ({
					name: newCollection.collection!,
					type: 'collection',
				})
			),
			...state.newCollections
				.filter((newCollection) => !!newCollection.fields)
				.map((newCollection) =>
					newCollection.fields!.map((field) => ({ ...field, collection: newCollection.collection }))
				)
				.flat()
				.map(
					(newField): GenerationInfo => ({
						name: `${newField.collection}.${newField.field}`,
						type: 'field',
					})
				),
			...state.newFields.map(
				(newField): GenerationInfo => ({
					name: `${newField.collection}.${newField.field}`,
					type: 'field',
				})
			),
		];
	});

	const isExisting = field !== '+';

	if (isExisting) {
		const existingField = clone(fieldsStore.getField(collection, field));

		state.fieldData.field = existingField.field;
		state.fieldData.type = existingField.type;
		state.fieldData.schema = existingField.schema;
		state.fieldData.meta = existingField.meta;

		state.relations = relationsStore.getRelationsForField(collection, field);
	} else {
		state.autoFillJunctionRelation = true;

		watch(
			() => availableInterfaces.value,
			() => {
				if (availableInterfaces.value.length === 1 && state.fieldData.meta) {
					state.fieldData.meta.interface = availableInterfaces.value[0].id;
				}
			}
		);

		watch(
			() => availableDisplays.value,
			() => {
				if (availableDisplays.value.length === 1 && state.fieldData.meta) {
					state.fieldData.meta.display = availableDisplays.value[0].id;
				}
			}
		);
	}

	// Auto generate translations
	if (isExisting === false && type === 'translations' && state.fieldData.meta) {
		state.fieldData.meta.interface = 'translations';
	}

	if (type === 'file') useFile();
	else if (type === 'm2o') useM2O();
	else if (type === 'm2m' || type === 'files' || type === 'translations') useM2M();
	else if (type === 'o2m') useO2M();
	else if (type === 'presentation') usePresentation();
	else if (type === 'm2a') useM2A();
	else useStandard();

	function useFile() {
		if (!isExisting) {
			state.fieldData.type = 'uuid';

			state.relations = [
				{
					collection: collection,
					field: '',
					related_collection: 'directus_files',
					meta: {
						sort_field: null,
					},
				},
			];
		}

		watch(
			() => state.fieldData.field,
			() => {
				state.relations[0].field = state.fieldData.field;
			}
		);
	}

	function useM2O() {
		const syncNewCollectionsM2O = throttle(() => {
			const collectionName = state.relations[0].related_collection;
			if (!collectionName) return;

			if (collectionExists(collectionName)) {
				state.newCollections = [];
			} else {
				const pkFieldName = state.newCollections?.[0]?.fields?.[0]?.field || 'id';

				state.newCollections = [
					{
						collection: collectionName,
						fields: [
							{
								field: pkFieldName,
								type: 'integer',
								schema: {
									has_auto_increment: true,
									is_primary_key: true,
								},
								meta: {
									hidden: true,
								},
							},
						],
					},
				];
			}
		}, 50);

		if (isExisting === false) {
			state.relations = [
				{
					collection: collection,
					field: '',
					related_collection: '',
					meta: {
						sort_field: null,
					},
				},
			];
		}

		watch(
			() => state.fieldData.field,
			() => {
				state.relations[0].field = state.fieldData.field;
			}
		);

		// Make sure to keep the current m2o field type in sync with the primary key of the
		// selected related collection
		watch(
			() => state.relations[0].related_collection,
			() => {
				if (state.relations[0].related_collection && collectionExists(state.relations[0].related_collection)) {
					const field = fieldsStore.getPrimaryKeyFieldForCollection(state.relations[0].related_collection);
					state.fieldData.type = field.type;
				} else {
					state.fieldData.type = 'integer';
				}
			}
		);

		// Sync the "auto generate related o2m"
		watch(
			() => state.relations[0].related_collection,
			() => {
				if (state.newFields.length > 0 && state.relations[0].related_collection) {
					state.newFields[0].collection = state.relations[0].related_collection;
				}
			}
		);

		watch([() => state.relations[0].related_collection], syncNewCollectionsM2O);
	}

	function useO2M() {
		delete state.fieldData.schema;
		delete state.fieldData.type;

		const syncNewCollectionsO2M = throttle(([collectionName, fieldName, sortField]) => {
			state.newCollections = state.newCollections.filter((col: any) => ['related'].includes(col.$type) === false);

			state.newFields = state.newFields.filter((field) => ['manyRelated', 'sort'].includes(field.$type!) === false);

			if (collectionExists(collectionName) === false) {
				state.newCollections.push({
					$type: 'related',
					collection: collectionName,
					fields: [
						{
							field: 'id',
							type: 'integer',
							schema: {
								has_auto_increment: true,
								is_primary_key: true,
							},
							meta: {
								hidden: true,
							},
						},
					],
				});
			}

			if (fieldExists(collectionName, fieldName) === false) {
				state.newFields.push({
					$type: 'manyRelated',
					collection: collectionName,
					field: fieldName,
					type: collectionExists(collectionName)
						? fieldsStore.getPrimaryKeyFieldForCollection(collectionName)?.type
						: 'integer',
					schema: {},
				});
			}

			if (sortField && fieldExists(collectionName, sortField) === false) {
				state.newFields.push({
					$type: 'sort',
					collection: collectionName,
					field: sortField,
					type: 'integer',
					schema: {},
					meta: {
						hidden: true,
					},
				});
			}
		}, 50);

		if (!isExisting) {
			state.fieldData.meta = {
				...(state.fieldData.meta || {}),
				special: ['o2m'],
			};

			state.relations = [
				{
					collection: '',
					field: '',
					related_collection: collection,
					meta: {
						one_field: state.fieldData.field,
						sort_field: null,
					},
				},
			];
		}

		watch(
			() => state.fieldData.field,
			() => {
				state.relations[0].meta = {
					...(state.relations[0].meta || {}),
					one_field: state.fieldData.field,
				};
			}
		);

		watch(
			[() => state.relations[0].collection, () => state.relations[0].field, () => state.relations[0].meta?.sort_field],
			syncNewCollectionsO2M
		);
	}

	function useM2M() {
		delete state.fieldData.schema;
		delete state.fieldData.type;

		const syncNewCollectionsM2M = throttle(
			([junctionCollection, manyCurrent, manyRelated, relatedCollection, sortField]) => {
				state.newCollections = state.newCollections.filter(
					(col: any) => ['junction', 'related'].includes(col.$type) === false
				);
				state.newFields = state.newFields.filter(
					(field) => ['manyCurrent', 'manyRelated', 'sort'].includes(field.$type!) === false
				);

				if (collectionExists(junctionCollection) === false) {
					state.newCollections.push({
						$type: 'junction',
						collection: junctionCollection,
						meta: {
							hidden: true,
							icon: 'import_export',
						},
						fields: [
							{
								field: 'id',
								type: 'integer',
								schema: {
									has_auto_increment: true,
								},
								meta: {
									hidden: true,
								},
							},
						],
					});
				}

				if (fieldExists(junctionCollection, manyCurrent) === false) {
					state.newFields.push({
						$type: 'manyCurrent',
						collection: junctionCollection,
						field: manyCurrent,
						type: fieldsStore.getPrimaryKeyFieldForCollection(collection)!.type,
						schema: {},
						meta: {
							hidden: true,
						},
					});
				}

				if (fieldExists(junctionCollection, manyRelated) === false) {
					if (type === 'translations') {
						state.newFields.push({
							$type: 'manyRelated',
							collection: junctionCollection,
							field: manyRelated,
							type: collectionExists(relatedCollection)
								? fieldsStore.getPrimaryKeyFieldForCollection(relatedCollection)?.type
								: 'string',
							schema: {},
							meta: {
								hidden: true,
							},
						});
					} else {
						state.newFields.push({
							$type: 'manyRelated',
							collection: junctionCollection,
							field: manyRelated,
							type: collectionExists(relatedCollection)
								? fieldsStore.getPrimaryKeyFieldForCollection(relatedCollection)?.type
								: 'integer',
							schema: {},
							meta: {
								hidden: true,
							},
						});
					}
				}

				if (collectionExists(relatedCollection) === false) {
					if (type === 'translations') {
						state.newCollections.push({
							$type: 'related',
							collection: relatedCollection,
							meta: {
								icon: 'translate',
							},
							fields: [
								{
									field: 'id',
									type: 'string',
									schema: {
										is_primary_key: true,
									},
									meta: {
										interface: 'input',
										options: {
											iconLeft: 'vpn_key',
										},
										width: 'half',
									},
								},
								{
									field: 'name',
									type: 'string',
									schema: {},
									meta: {
										interface: 'input',
										options: {
											iconLeft: 'translate',
										},
										width: 'half',
									},
								},
							],
						});
					} else {
						state.newCollections.push({
							$type: 'related',
							collection: relatedCollection,
							fields: [
								{
									field: 'id',
									type: 'integer',
									schema: {
										has_auto_increment: true,
									},
									meta: {
										hidden: true,
									},
								},
							],
						});
					}
				}

				if (type === 'translations') {
					if (collectionExists(relatedCollection) === false) {
						state.newRows = {
							[relatedCollection]: [
								{
									code: 'en-US',
									name: 'English',
								},
								{
									code: 'de-DE',
									name: 'German',
								},
								{
									code: 'fr-FR',
									name: 'French',
								},
								{
									code: 'ru-RU',
									name: 'Russian',
								},
								{
									code: 'es-ES',
									name: 'Spanish',
								},
								{
									code: 'it-IT',
									name: 'Italian',
								},
								{
									code: 'pt-BR',
									name: 'Portuguese',
								},
							],
						};
					} else {
						state.newRows = {};
					}
				}

				if (sortField && fieldExists(junctionCollection, sortField) === false) {
					state.newFields.push({
						$type: 'sort',
						collection: junctionCollection,
						field: sortField,
						type: 'integer',
						schema: {},
						meta: {
							hidden: true,
						},
					});
				}
			},
			50
		);

		if (!isExisting) {
			state.fieldData.meta = {
				...(state.fieldData.meta || {}),
				special: [type],
			};

			state.relations = [
				{
					collection: '',
					field: '',
					related_collection: collection,
					meta: {
						one_field: state.fieldData.field,
						sort_field: null,
					},
				},
				{
					collection: '',
					field: '',
					related_collection: '',
					meta: {
						one_field: null,
						sort_field: null,
					},
				},
			];
		}

		watch(
			() => state.relations[0].field,
			() => {
				state.relations[1].meta = {
					...state.relations[1].meta,
					junction_field: state.relations[0].field,
				};
			}
		);

		watch(
			() => state.relations[1].field,
			() => {
				state.relations[0].meta = {
					...(state.relations[0].meta || {}),
					junction_field: state.relations[1].field,
				};
			}
		);

		watch(
			[
				() => state.relations[0].collection,
				() => state.relations[0].field,
				() => state.relations[1].field,
				() => state.relations[1].related_collection,
				() => state.relations[0].meta?.sort_field,
			],
			syncNewCollectionsM2M
		);

		watch(
			() => state.fieldData.field,
			() => {
				state.relations[0].meta = {
					...(state.relations[0].meta || {}),
					one_field: state.fieldData.field,
				};

				if (state.fieldData.field && collectionExists(state.fieldData.field) && type !== 'translations') {
					state.relations[0].collection = getAutomaticJunctionCollectionName();
					state.relations[0].field = `${state.relations[0].related_collection}_id`;
					state.relations[1].related_collection = state.fieldData.field;

					state.relations[1].collection = `${state.relations[0].related_collection}_${state.relations[1].related_collection}`;
					state.relations[1].field = `${state.relations[1].related_collection}_id`;

					if (state.relations[0].field === state.relations[1].field) {
						state.relations[1].field = `${state.relations[1].related_collection}_related_id`;
					}
				}
			}
		);

		if (type === 'files') {
			Vue.nextTick(() => {
				state.relations[1].related_collection = 'directus_files';
			});
		}

		if (type !== 'translations') {
			let stop: WatchStopHandle;

			watch(
				() => state.autoFillJunctionRelation,
				(startWatching) => {
					if (startWatching) {
						stop = watch(
							() => state.relations[1].related_collection,
							(newRelatedCollection) => {
								if (newRelatedCollection) {
									state.relations[0].collection = getAutomaticJunctionCollectionName();
									state.relations[1].collection = getAutomaticJunctionCollectionName();
								}

								if (state.relations[0].field === state.relations[1].field) {
									state.relations[1].field = `${state.relations[1].related_collection}_related_id`;
								}
							}
						);
					} else {
						stop?.();
					}
				},
				{ immediate: true }
			);
		}

		if (type === 'translations') {
			watch(
				() => state.relations[0].collection,
				(newManyCollection) => {
					state.relations[1].collection = newManyCollection;
				},
				{ immediate: true }
			);

			state.relations[0].collection = `${collection}_translations`;

			state.relations[0].field = `${collection}_${fieldsStore.getPrimaryKeyFieldForCollection(collection)?.field}`;

			state.relations[1].related_collection = 'languages';

			state.relations[1].field = `${state.relations[1].related_collection}_id`;

			state.fieldData.field = 'translations';
			state.relations[0].meta = {
				...state.relations[0].meta,
				one_field: 'translations',
			};
		}

		function getAutomaticJunctionCollectionName() {
			let index = 0;
			let name = getName(index);

			while (collectionExists(name)) {
				index++;
				name = getName(index);
			}

			return name;

			function getName(index: number) {
				const name = `${state.relations[0].related_collection}_${state.relations[1].related_collection}`;
				if (index) return name + '_' + index;
				return name;
			}
		}
	}

	function useM2A() {
		delete state.fieldData.schema;
		delete state.fieldData.type;

		const syncNewCollectionsM2A = throttle(
			([junctionCollection, manyCurrent, manyRelated, oneCollectionField, sortField]) => {
				state.newCollections = state.newCollections.filter(
					(col: any) => ['junction', 'related'].includes(col.$type) === false
				);

				state.newFields = state.newFields.filter(
					(field) => ['manyCurrent', 'manyRelated', 'collectionField', 'sort'].includes(field.$type!) === false
				);

				if (collectionExists(junctionCollection) === false) {
					state.newCollections.push({
						$type: 'junction',
						collection: junctionCollection,
						meta: {
							hidden: true,
							icon: 'import_export',
						},
						fields: [
							{
								field: 'id',
								type: 'integer',
								schema: {
									has_auto_increment: true,
								},
								meta: {
									hidden: true,
								},
							},
						],
					});
				}

				if (fieldExists(junctionCollection, manyCurrent) === false) {
					state.newFields.push({
						$type: 'manyCurrent',
						collection: junctionCollection,
						field: manyCurrent,
						type: fieldsStore.getPrimaryKeyFieldForCollection(collection)!.type,
						schema: {},
						meta: {
							hidden: true,
						},
					});
				}

				if (fieldExists(junctionCollection, manyRelated) === false) {
					state.newFields.push({
						$type: 'manyRelated',
						collection: junctionCollection,
						field: manyRelated,
						// We'll have to save the foreign key as a string, as that's the only way to safely
						// be able to store the PK of multiple typed collections
						type: 'string',
						schema: {},
						meta: {
							hidden: true,
						},
					});
				}

				if (fieldExists(junctionCollection, oneCollectionField) === false) {
					state.newFields.push({
						$type: 'collectionField',
						collection: junctionCollection,
						field: oneCollectionField,
						type: 'string', // directus_collections.collection is a string
						schema: {},
						meta: {
							hidden: true,
						},
					});
				}

				if (sortField && fieldExists(junctionCollection, sortField) === false) {
					state.newFields.push({
						$type: 'sort',
						collection: junctionCollection,
						field: sortField,
						type: 'integer',
						schema: {},
						meta: {
							hidden: true,
						},
					});
				}
			},
			50
		);

		if (!isExisting) {
			state.fieldData.meta = {
				...(state.fieldData.meta || {}),
				special: [type],
			};

			state.relations = [
				{
					collection: '',
					field: '',
					related_collection: collection,
					meta: {
						one_field: state.fieldData.field,
						sort_field: null,
					},
				},
				{
					collection: '',
					field: '',
					related_collection: null,
					meta: {
						one_field: null,
						one_allowed_collections: [],
						one_collection_field: '',
						sort_field: null,
					},
				},
			];
		}

		watch(
			() => state.relations[0].collection,
			() => {
				if (state.relations[0].collection && collectionExists(state.relations[0].collection)) {
					const pkField = fieldsStore.getPrimaryKeyFieldForCollection(state.relations[0].collection)?.field;
				}
			}
		);

		watch(
			() => state.relations[0].field,
			() => {
				state.relations[1].meta = {
					...(state.relations[1].meta || {}),
					junction_field: state.relations[0].field,
				};
			}
		);

		watch(
			() => state.relations[1].field,
			() => {
				state.relations[0].meta = {
					...(state.relations[0].meta || {}),
					junction_field: state.relations[1].field,
				};
			}
		);

		watch(
			[
				() => state.relations[0].collection,
				() => state.relations[0].field,
				() => state.relations[1].field,
				() => state.relations[1].one_collection_field,
				() => state.relations[0].sort_field,
			],
			syncNewCollectionsM2A
		);

		watch(
			() => state.fieldData.field,
			() => {
				state.relations[0].one_field = state.fieldData.field;

				if (state.autoFillJunctionRelation) {
					state.relations[0].collection = `${state.relations[0].related_collection}_${state.fieldData.field}`;
					state.relations[1].collection = `${state.relations[0].related_collection}_${state.fieldData.field}`;
				}
			}
		);

		watch(
			() => state.autoFillJunctionRelation,
			() => {
				if (state.autoFillJunctionRelation === true) {
					state.relations[0].collection = `${state.relations[0].related_collection}_${state.fieldData.field}`;
					state.relations[1].collection = `${state.relations[0].related_collection}_${state.fieldData.field}`;
					state.relations[0].field = `${state.relations[0].related_collection}_${state.relations[0].one_primary}`;
					state.relations[1].one_collection_field = 'collection';
					state.relations[1].field = 'item';
				}
			},
			{ immediate: true }
		);
	}

	function usePresentation() {
		delete state.fieldData.schema;
		state.fieldData.type = null;

		state.fieldData.meta.special = ['alias', 'no-data'];
	}

	function useStandard() {
		watch(
			() => state.fieldData.type,
			() => {
				state.fieldData.meta.interface = null;
				state.fieldData.meta.options = null;
				state.fieldData.meta.display = null;
				state.fieldData.meta.display_options = null;
				state.fieldData.meta.special = null;
				state.fieldData.schema.default_value = undefined;
				state.fieldData.schema.max_length = undefined;
				state.fieldData.schema.is_nullable = true;

				switch (state.fieldData.type) {
					case 'uuid':
						state.fieldData.meta.special = ['uuid'];
						break;
					case 'hash':
						state.fieldData.meta.special = ['hash'];
						break;
					case 'json':
						state.fieldData.meta.special = ['json'];
						break;
					case 'csv':
						state.fieldData.meta.special = ['csv'];
						break;
					case 'boolean':
						state.fieldData.meta.special = ['boolean'];
						state.fieldData.schema.default_value = false;
						state.fieldData.schema.is_nullable = false;
						break;
				}
			}
		);
	}

	function collectionExists(collection: string) {
		return collectionsStore.getCollection(collection) !== null;
	}

	function fieldExists(collection: string, field: string) {
		return collectionExists(collection) && !!fieldsStore.getField(collection, field);
	}
}

function clearLocalStore(): void {
	state = null;
}
