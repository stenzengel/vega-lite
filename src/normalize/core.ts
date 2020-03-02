import {isArray} from 'vega-util';
import {COLUMN, FACET, ROW} from '../channel';
import {Field, FieldName} from '../channeldef';
import {replaceRepeaterInEncoding, replaceRepeaterInFacet} from '../compile/repeater';
import {boxPlotNormalizer} from '../compositemark/boxplot';
import {errorBandNormalizer} from '../compositemark/errorband';
import {errorBarNormalizer} from '../compositemark/errorbar';
import {channelHasField, Encoding} from '../encoding';
import * as log from '../log';
import {Projection} from '../projection';
import {FacetedUnitSpec, GenericSpec, LayerSpec, UnitSpec} from '../spec';
import {GenericCompositionLayoutWithColumns} from '../spec/base';
import {GenericConcatSpec} from '../spec/concat';
import {
  FacetEncodingFieldDef,
  FacetFieldDef,
  FacetMapping,
  GenericFacetSpec,
  isFacetMapping,
  NormalizedFacetSpec
} from '../spec/facet';
import {NormalizedSpec} from '../spec/index';
import {GenericLayerSpec, NormalizedLayerSpec} from '../spec/layer';
import {SpecMapper} from '../spec/map';
import {RepeatSpec} from '../spec/repeat';
import {isUnitSpec, NormalizedUnitSpec} from '../spec/unit';
import {keys, omit, varName} from '../util';
import {NonFacetUnitNormalizer, NormalizerParams} from './base';
import {PathOverlayNormalizer} from './pathoverlay';
import {RangeStepNormalizer} from './rangestep';
import {RuleForRangedLineNormalizer} from './ruleforrangedline';

export class CoreNormalizer extends SpecMapper<NormalizerParams, FacetedUnitSpec, LayerSpec> {
  private nonFacetUnitNormalizers: NonFacetUnitNormalizer<any>[] = [
    boxPlotNormalizer,
    errorBarNormalizer,
    errorBandNormalizer,
    new PathOverlayNormalizer(),
    new RuleForRangedLineNormalizer(),
    new RangeStepNormalizer()
  ];

  public map(spec: GenericSpec<FacetedUnitSpec, LayerSpec, RepeatSpec, Field>, params: NormalizerParams) {
    // Special handling for a faceted unit spec as it can return a facet spec, not just a layer or unit spec like a normal unit spec.
    if (isUnitSpec(spec)) {
      const hasRow = channelHasField(spec.encoding, ROW);
      const hasColumn = channelHasField(spec.encoding, COLUMN);
      const hasFacet = channelHasField(spec.encoding, FACET);

      if (hasRow || hasColumn || hasFacet) {
        return this.mapFacetedUnit(spec, params);
      }
    }

    return super.map(spec, params);
  }

  // This is for normalizing non-facet unit
  public mapUnit(spec: UnitSpec, params: NormalizerParams): NormalizedUnitSpec | NormalizedLayerSpec {
    const {parentEncoding, parentProjection} = params;

    const specWithReplacedEncoding = {...spec, encoding: replaceRepeaterInEncoding(spec.encoding, params.repeater)};

    if (parentEncoding || parentProjection) {
      return this.mapUnitWithParentEncodingOrProjection(specWithReplacedEncoding, params);
    }

    const normalizeLayerOrUnit = this.mapLayerOrUnit.bind(this);

    for (const unitNormalizer of this.nonFacetUnitNormalizers) {
      if (unitNormalizer.hasMatchingType(specWithReplacedEncoding, params.config)) {
        return unitNormalizer.run(specWithReplacedEncoding, params, normalizeLayerOrUnit);
      }
    }

    return specWithReplacedEncoding as NormalizedUnitSpec;
  }

  protected mapRepeat(spec: RepeatSpec, params: NormalizerParams): GenericConcatSpec<NormalizedSpec> {
    const {repeat, spec: childSpec, data, ...remainingProperties} = spec;

    if (!isArray(repeat) && spec.columns) {
      // is repeat with row/column
      spec = omit(spec, ['columns']);
      log.warn(log.message.columnsNotSupportByRowCol('repeat'));
    }

    const children: NormalizedSpec[] = [];

    const repeater = params.repeater;

    const row = (!isArray(repeat) && repeat.row) || [repeater ? repeater.row : null];
    const column = (!isArray(repeat) && repeat.column) || [repeater ? repeater.column : null];
    const repeatValues = (isArray(repeat) && repeat) || [repeater ? repeater.repeat : null];

    // cross product
    for (const repeatValue of repeatValues) {
      for (const rowValue of row) {
        for (const columnValue of column) {
          const childRepeater = {
            repeat: repeatValue,
            row: rowValue,
            column: columnValue
          };

          const child = this.map(childSpec, {...params, repeater: childRepeater});

          child.name =
            (repeatValue ? `__repeat_${varName(repeatValue)}` : '') +
            (rowValue ? `__row_${varName(rowValue)}` : '') +
            (columnValue ? `__column_${varName(columnValue)}` : '');

          // we move data up
          children.push(omit(child, ['data']) as NormalizedSpec);
        }
      }
    }

    const columns = isArray(repeat) ? spec.columns : repeat.column ? repeat.column.length : 1;

    return {
      data: data ?? childSpec.data, // data from child spec should have precedence
      ...remainingProperties,
      columns,
      concat: children
    };
  }

  protected mapFacet(
    spec: GenericFacetSpec<UnitSpec, LayerSpec, Field>,
    params: NormalizerParams
  ): GenericFacetSpec<NormalizedUnitSpec, NormalizedLayerSpec, FieldName> {
    const {facet} = spec;

    if (isFacetMapping(facet) && spec.columns) {
      // is facet with row/column
      spec = omit(spec, ['columns']);
      log.warn(log.message.columnsNotSupportByRowCol('facet'));
    }

    return super.mapFacet(spec, params);
  }

  private mapUnitWithParentEncodingOrProjection(
    spec: FacetedUnitSpec,
    params: NormalizerParams
  ): NormalizedUnitSpec | NormalizedLayerSpec {
    const {encoding, projection} = spec;
    const {parentEncoding, parentProjection, config} = params;
    const mergedProjection = mergeProjection({parentProjection, projection});
    const mergedEncoding = mergeEncoding({
      parentEncoding,
      encoding: replaceRepeaterInEncoding(encoding, params.repeater)
    });

    return this.mapUnit(
      {
        ...spec,
        ...(mergedProjection ? {projection: mergedProjection} : {}),
        ...(mergedEncoding ? {encoding: mergedEncoding} : {})
      },
      {config}
    );
  }

  private mapFacetedUnit(spec: FacetedUnitSpec, params: NormalizerParams): NormalizedFacetSpec {
    // New encoding in the inside spec should not contain row / column
    // as row/column should be moved to facet
    const {row, column, facet, ...encoding} = spec.encoding;

    // Mark and encoding should be moved into the inner spec
    const {mark, width, projection, height, view, selection, encoding: _, ...outerSpec} = spec;

    const {facetMapping, layout} = this.getFacetMappingAndLayout({row, column, facet}, params);

    return this.mapFacet(
      {
        ...outerSpec,
        ...layout,

        // row / column has higher precedence than facet
        facet: facetMapping,
        spec: {
          ...(width ? {width} : {}),
          ...(height ? {height} : {}),
          ...(view ? {view} : {}),
          ...(projection ? {projection} : {}),
          mark,
          encoding: replaceRepeaterInEncoding(encoding, params.repeater),
          ...(selection ? {selection} : {})
        }
      },
      params
    );
  }

  private getFacetMappingAndLayout(
    facets: {
      row: FacetEncodingFieldDef<Field>;
      column: FacetEncodingFieldDef<Field>;
      facet: FacetEncodingFieldDef<Field>;
    },
    params: NormalizerParams
  ): {facetMapping: FacetMapping<FieldName> | FacetFieldDef<FieldName>; layout: GenericCompositionLayoutWithColumns} {
    const {row, column, facet} = facets;

    if (row || column) {
      if (facet) {
        log.warn(log.message.facetChannelDropped([...(row ? [ROW] : []), ...(column ? [COLUMN] : [])]));
      }

      const facetMapping = {};
      const layout = {};

      for (const channel of [ROW, COLUMN]) {
        const def = facets[channel];
        if (def) {
          const {align, center, spacing, columns, ...defWithoutLayout} = def;
          facetMapping[channel] = defWithoutLayout;

          for (const prop of ['align', 'center', 'spacing'] as const) {
            if (def[prop] !== undefined) {
              layout[prop] = layout[prop] ?? {};
              layout[prop][channel] = def[prop];
            }
          }
        }
      }

      return {facetMapping, layout};
    } else {
      const {align, center, spacing, columns, ...facetMapping} = facet;
      return {
        facetMapping: replaceRepeaterInFacet(facetMapping, params.repeater),
        layout: {
          ...(align ? {align} : {}),
          ...(center ? {center} : {}),
          ...(spacing ? {spacing} : {}),
          ...(columns ? {columns} : {})
        }
      };
    }
  }

  public mapLayer(
    spec: LayerSpec,
    {parentEncoding, parentProjection, ...otherParams}: NormalizerParams
  ): GenericLayerSpec<NormalizedUnitSpec> {
    // Special handling for extended layer spec

    const {encoding, projection, ...rest} = spec;
    const params: NormalizerParams = {
      ...otherParams,
      parentEncoding: mergeEncoding({parentEncoding, encoding}),
      parentProjection: mergeProjection({parentProjection, projection})
    };
    return super.mapLayer(rest, params);
  }
}

function mergeEncoding(opt: {parentEncoding: Encoding<any>; encoding: Encoding<any>}): Encoding<any> {
  const {parentEncoding, encoding} = opt;
  if (parentEncoding && encoding) {
    const overriden = keys(parentEncoding).reduce((o, key) => {
      if (encoding[key]) {
        o.push(key);
      }
      return o;
    }, []);

    if (overriden.length > 0) {
      log.warn(log.message.encodingOverridden(overriden));
    }
  }

  const merged = {
    ...(parentEncoding ?? {}),
    ...(encoding ?? {})
  };
  return keys(merged).length > 0 ? merged : undefined;
}

function mergeProjection(opt: {parentProjection: Projection; projection: Projection}) {
  const {parentProjection, projection} = opt;
  if (parentProjection && projection) {
    log.warn(log.message.projectionOverridden({parentProjection, projection}));
  }
  return projection ?? parentProjection;
}
