'use strict';

const _ = require('lodash');
const { sanitizeEntity } = require('strapi-utils');
const PluginError = require('./utils/error');
const { isEqualEntity, extractMeta, buildNestedStructure, checkBadWords, filterOurResolvedReports } = require('./utils/functions');

/**
 * comments.js service
 *
 * @description: A set of functions similar to controller's actions to avoid code duplication.
 */

module.exports = {
    // Find all comments
    findAll: async (query) => {
        const { pluginName, model } = extractMeta(strapi.plugins);
        const paginationEnabled = !_.isNil(query._start);
        const params = {
            ...query,
            _sort: paginationEnabled ? query._sort || 'created_at:desc' : undefined
        };
        const entities = query._q ? 
            await strapi.query( model.modelName, pluginName).search(params, ['authorUser', 'related', 'reports']) :
            await strapi.query( model.modelName, pluginName).find(params, ['authorUser', 'related', 'reports']);
        const items = entities.map(_ => filterOurResolvedReports(sanitizeEntity(_, { model })));
        const total = paginationEnabled ?
            query._q ?
                await strapi.query( model.modelName, pluginName).countSearch(params) : 
                await strapi.query( model.modelName, pluginName).count(params) :
            items.length;
        return {
            items,
            total,
            page: paginationEnabled ? query._start/query._limit : undefined,
        };
    },

    // Find comments in the flat structure
    findAllFlat: async (relation) => {
        const { pluginName, model } = extractMeta(strapi.plugins);
        let criteria = {};
        if (relation) {
            criteria = {
                ...criteria,
                relatedSlug: relation,
            };
        }
        const entities = await strapi.query( model.modelName, pluginName)
            .find(criteria, ['authorUser', 'related', 'reports']);
        return entities.map(_ => filterOurResolvedReports(sanitizeEntity(_, { model })));
    },

    // Find comments and create relations tree structure
    findAllInHierarchy: async (relation, startingFromId = null, dropBlockedThreads = false) => {
        const { service } = extractMeta(strapi.plugins);
        const entities = await service.findAllFlat(relation);
        return buildNestedStructure(entities, startingFromId, 'threadOf', dropBlockedThreads);
    },

    // Find single comment
    findOne: async (id, relation) => {
        const { pluginName, model } = extractMeta(strapi.plugins);
        let criteria = { id };
        if (relation) {
            criteria = {
                ...criteria,
                relatedSlug: relation,
            };
        }
        const entity = await strapi.query( model.modelName, pluginName)
            .findOne(criteria, ['related', 'reports']);
        return filterOurResolvedReports(sanitizeEntity(entity, { model }));
    },

    // Create a comment
    create: async (data, relation) => {
        const { content, related } = data;
        const { service, model } = extractMeta(strapi.plugins);
        const parsedRelation = related && related instanceof Array ? related : [related];
        const singleRelationFulfilled = related && (parsedRelation.length === 1);
        const linkToThread = data.threadOf ? !!sanitizeEntity(await service.findOne(data.threadOf, relation), { model }) : true;
        
        if (!linkToThread) {
            throw new PluginError(400, 'Thread is not existing');
        }
        
        if (checkBadWords(content) && singleRelationFulfilled) {
            const { pluginName, model } = extractMeta(strapi.plugins);
            const relatedEntity = !_.isEmpty(related) ? _.first(related) : null;
            const entity = await strapi.query( model.modelName, pluginName).create({
                ...data,
                relatedSlug: relatedEntity ? `${relatedEntity.ref}:${relatedEntity.refId}` : relation,
                related: parsedRelation
            });
            return  sanitizeEntity(entity, { model });
        }
        throw new PluginError(400, 'No content received.');
    },

    // Update a comment
    update: async (id, relation, data) => {
        const { content } = data;
        const { pluginName, service, model } = extractMeta(strapi.plugins);
        const existingEntity = sanitizeEntity(await service.findOne(id, relation), { model });
        if (isEqualEntity(existingEntity, data) && content) {
            if (checkBadWords(content)) {
                const entity = await strapi.query( model.modelName, pluginName).update(
                    { id },
                    { content }
                );
                return sanitizeEntity(entity, { model }) ;
            }
        }
        throw new PluginError(409, 'Action on that entity is not allowed');
    },

    // Points up for comment
    pointsUp: async (id, relation) => {
        const { pluginName, service, model } = extractMeta(strapi.plugins);
        const existingEntity = sanitizeEntity(await service.findOne(id, relation), { model });
        if (existingEntity) {
            const entity = await strapi.query( model.modelName, pluginName).update(
                { id },
                {
                    points: (existingEntity.points || 0) + 1,
                }
            );
            return sanitizeEntity(entity, { model }) ;
        }
        throw new PluginError(409, 'Action on that entity is not allowed');
    },

    // Report abuse in comment
    reportAbuse: async (id, relation, payload) => {
        const { pluginName, plugin, model, service  } = extractMeta(strapi.plugins);
        const { report: reportModel } = plugin.models;
        const existingEntity = sanitizeEntity(await service.findOne(id, relation), { model }); 
        if (existingEntity) {
            const entity = await strapi.query(reportModel.modelName, pluginName).create({
                ...payload,
                resolved: false,
                related: id,
            });
            return sanitizeEntity(entity, { model: reportModel }) ;
        }
        throw new PluginError(409, 'Action on that entity is not allowed');
    },

    //
    // Moderation
    //

    // Find single comment
    findOneAndThread: async (id) => {
        const { pluginName, service, model } = extractMeta(strapi.plugins);
        const entity = await strapi.query( model.modelName, pluginName).findOne({ id }, ['threadOf', 'threadOf.reports', 'authorUser', 'related', 'reports']);
        const relatedEntity = !_.isEmpty(entity.related) ? _.first(entity.related) : null;
        const relation = relatedEntity ? `${relatedEntity.__contentType.toLowerCase()}:${relatedEntity.id}` : null;
        const entitiesOnSameLevel = await service.findAllInHierarchy(relation, entity.threadOf ? entity.threadOf.id : null)
        const selectedEntity = filterOurResolvedReports(sanitizeEntity(entity, { model }));
        return {
            selected: {
                ...selectedEntity,
                threadOf: selectedEntity.threadOf ? filterOurResolvedReports(selectedEntity.threadOf) : null,
            },
            level: entitiesOnSameLevel.map(_ => filterOurResolvedReports(sanitizeEntity(_, { model })))
        };
    },

    // Block / Unblock a comment
    blockComment: async (id) => {
        const { pluginName, service, model } = extractMeta(strapi.plugins);
        const existingEntity = await service.findOne(id);
        const changedEntity = await strapi.query( model.modelName, pluginName).update(
            { id },
            { blocked: !existingEntity.blocked }
        );
        return sanitizeEntity(changedEntity, { model });
    },

    // Block / Unblock a comment thread
    blockCommentThread: async (id) => {
        const { pluginName, service, model } = extractMeta(strapi.plugins);
        const existingEntity = await service.findOne(id);
        const changedEntity = await strapi.query( model.modelName, pluginName).update(
            { id },
            { blockedThread: !existingEntity.blockedThread }
        );
        await service.blockCommentThreadNested(id, !existingEntity.blockedThread)
        return sanitizeEntity(changedEntity, { model });
    },

    blockCommentThreadNested: async (id, blockStatus) => {
        const { pluginName, service, model } = extractMeta(strapi.plugins);
        try {
            const entitiesToChange = await strapi.query(model.modelName, pluginName).find({ threadOf: id });
            const changedEntities = await Promise.all(entitiesToChange.map(item => strapi.query(model.modelName, pluginName).update(
                { id: item.id },
                { blockedThread: blockStatus }
            )));
            if (changedEntities) {
                const changedEntitiesList = changedEntities instanceof Array ? changedEntities : [changedEntities];
                const nestedTransactions = await Promise.all(
                    changedEntitiesList.map(item => service.blockCommentThreadNested(item.id, blockStatus))
                );
                return nestedTransactions.length === changedEntitiesList.length;
            }
            return true;    
        } catch (e) {
            return false;
        }
    },

    // Resolve reported abuse for comment
    resolveAbuseReport: async (id, commentId) => {
        const { pluginName, plugin  } = extractMeta(strapi.plugins);
        const { report: reportModel } = plugin.models;
        const entity = await strapi.query(reportModel.modelName, pluginName).update({
            id,
            related: commentId,
        }, {
            resolved: true,
        });
        return sanitizeEntity(entity, { model: reportModel }) ;
    },
};
